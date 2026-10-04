import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ThreadResultHistory, ThreadResultHistoryReleaseParams, ThreadResultHistoryReleaseResult } from "@varin/application-client";
import type {
  AgentInputContext,
  HarnessWorktreeSettings,
  PiMessage,
  PiSessionMessageEntry,
  SessionEntriesResult,
  SessionSnapshot,
  SessionStats,
  SessionSummary,
  Thread,
  ThreadConflictResolution,
  ThreadParent,
  ThreadReport,
  ThreadRun,
  ThreadRunOutcome,
  ThreadOccupancy,
  ThreadSpaceMeasurement,
  ThreadRestoreStatus,
  WorkingBranchEnsureMaterializedResult,
  WorkspaceThreadSpace,
} from "@varin/protocol";
import {
  assembleFreshInput,
  HARNESS_TOOL_META,
  isAttachedRootPurpose,
  minePiBranchEntries,
  normalizeFrozenHarnessPermissions,
  threadIntegrationBindingFromPreview,
} from "@varin/protocol";
import { scopePathContainedBy } from "./thread-nesting.js";
import { isSessionScopeId, sessionScopeId } from "./owner-scope.js";
import {
  assembleKeepReasons,
  collectBranchObjectHashesFromRoot,
  collectDraftBaselineHashesFromRoot,
  measureDirectory,
  measurementFromHashes,
  measurementFromStates,
  mergeHashMaps,
  projectThreadOccupancy,
  projectWorkspaceSpace,
  readVolumeSpace,
} from "./working-state/thread-space.js";
import { sameFrozenRunConfig, ThreadAdmissionError, type CreateThreadInput, type ThreadRegistry } from "./thread-registry.js";
import type { ThreadWorktreeRuntime } from "./thread-worktree.js";
import type { IntegrationCoordinator, IntegrationPlanInput } from "./working-state/integration-coordinator.js";
import { projectThreadResultHistory, type RetentionThreadSnapshot } from "./working-state/thread-history.js";
import type { RecoveryState, WorkingStatePin, WorkingStateRootStore, WorkspaceWorkingStateRootAccess } from "./working-state/types.js";
import { createBranchWithDraftBaseline } from "./working-state/draft-baseline.js";
import { rebaseBranchOntoParentRevision } from "./working-state/baseline-rebase.js";
import { updateMaterializedBaseline } from "./working-state/materialized-baseline-update.js";
import type { ThreadExecutionViewRegistry } from "./working-state/execution-view.js";
import { acquireVirtualWriteTicket, type VirtualWriteGate } from "./working-state/virtual-write-gate.js";
import {
  recoverMaterializationSwitch,
  removeOrphanMaterializationDirs,
  rollbackMaterializationSwitch,
  type MaterializationSwitchJournal,
} from "./working-state/materialization-switch.js";
import { encodeDocumentText } from "../documents/inspect.js";
import type { SurfaceSnapshotCloneResult } from "../documents/surface-snapshot-store.js";
import type { createSourceViewStore } from "./source-view-store.js";
import { normalizePathIdentity } from "../workspace/path-safety.js";
import { sameState } from "../recovery/journal-files.js";
import type { VerificationCoordinator } from "./verification-coordinator.js";
import { runNeedsMaterializedDirectory } from "./working-state/path-requirement.js";
import {
  directoryBaselineFingerprint,
  gitBaselineFingerprint,
  withAncestorDirectories,
  type GitBaselineInventory,
} from "./working-state/workspace-baseline.js";

export interface ThreadSessionAdapter {
  create(input: {
    modelSettings?: import("@varin/protocol").HarnessAgentModelSettings | null;
    cwd: string;
    name: string;
    parentSession: string;
    initialAuthorityRoot?: string;
    model?: { providerId: string; modelId: string };
    permissions?: import("@varin/protocol").PermissionPolicy;
    scope?: string[];
    tools: string[];
    workFocus: import("@varin/protocol").WorkFocusId;
    workspaceId: string;
  }): Promise<SessionSnapshot>;
  open(input: {
    modelSettings?: import("@varin/protocol").HarnessAgentModelSettings | null;
    cwd: string;
    model?: { providerId: string; modelId: string };
    permissions?: import("@varin/protocol").PermissionPolicy;
    scope?: string[];
    sessionId: string;
    tools: string[];
    workFocus: import("@varin/protocol").WorkFocusId;
    workspaceId: string;
  }): Promise<SessionSnapshot>;
  prompt(sessionId: string, text: string, instructions?: string, images?: import("@varin/protocol").ImageAttachment[], inputContext?: AgentInputContext): Promise<void>;
  send(sessionId: string, text: string): Promise<void>;
  /** Passive durable input; implementations must never emulate this with prompt/followUp. */
  notify?(sessionId: string, text: string, messageId: string): Promise<void>;
  request?(sessionId: string, text: string, messageId: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
  close(sessionId: string): Promise<void>;
  snapshot(sessionId: string): Promise<SessionSnapshot>;
  summary(sessionId: string): Promise<SessionSummary>;
  stats(sessionId: string): Promise<SessionStats>;
  entries(sessionId: string, scope?: "branch" | "all"): Promise<SessionEntriesResult>;
  /**
   * Read a persisted session's entries without opening a worker — used for
   * `fresh` input construction on a settled Thread's retained transcript.
   */
  captureInput?(sessionId: string): Promise<Pick<import("@varin/protocol").ThreadInheritedContext, "text" | "anchors" | "images"> | null>;
  readEntries?(sessionId: string, cwd: string | undefined, scope?: "branch" | "all"): Promise<SessionEntriesResult>;
}

export interface ThreadRuntimeOptions {
  registry: ThreadRegistry;
  sessions: ThreadSessionAdapter;
  /** Explicit kill/delete cleanup for experiments owned by a Thread. */
  stopExperimentsForThread?(workspaceId: string, threadId: string): Promise<void>;
  /** Deletes a Pi session's worker, file, and metadata (thread deletion, D-242). */
  deleteSession?(sessionId: string): Promise<unknown>;
  /**
   * Deletes a session's event/block/session knowledge nodes through
   * `KnowledgeStore.deleteSession` (D-242 rework). Accepted workspace/user
   * knowledge is retained —only the thread's own session knowledge is removed.
   */
  deleteKnowledgeSession?(workspaceId: string, sessionId: string): Promise<unknown>;
  /** Release retrieval evidence/receipt/artifact owners before the Thread row disappears. */
  releaseThreadEvidence?(workspaceId: string, threadId: string): Promise<void>;
  worktrees: Pick<ThreadWorktreeRuntime, "prepare" | "inspect" | "snapshot" | "merge"> &
    Partial<Pick<ThreadWorktreeRuntime, "assertOwnership" | "attachIsolatedGitContext" | "discardInput" | "estimatePrepare" | "inspectGitBaselineInventory" | "inspectIndexModes" | "inspectWorkspaceIdentity" | "prepareInputs" | "reclaim" | "materialize" | "runSetup" | "measureDiskUsage" | "verifyFixedResult">>;
  resolveWorkspaceRoot(workspaceId: string): Promise<string>;
  resolveRuntimeWorkspaceId(cwd: string): Promise<string>;
  /** Production R3 measurement of a managed execution directory through the kernel. */
  measureManagedDirectory?(workspaceId: string, worktree: NonNullable<Thread["worktree"]>): Promise<ThreadSpaceMeasurement>;
  inspectBaselineWriters?(workspaceId: string, root: string): Promise<Array<{ id: string; purpose?: string }>>;
  beginBaselineCapture?(workspaceId: string): Promise<unknown>;
  completeBaselineCapture?(capture: unknown): Promise<{ stable: boolean; reasons: string[] }>;
  beginDirtyStateBarrier?(workspaceId: string, paths: string[]): Promise<{
    release(): Promise<void>;
  }>;
  readBlocks?(sessionId: string): Promise<Array<{ label: string; content: string }> | null>;
  resolveBaselineApplyContext?: import("../recovery/durable-file-operation.js").ResolveDirectoryApplyContext;
  withMergeWriter?<T>(workspaceId: string, threadId: string, operation: () => Promise<T>): Promise<T>;
  onError?: (error: unknown) => void;
  /** Alert threshold only; it does not cancel or limit a Run. */
  stalledAfterMs?(providerId: string | null): number;
  worktreeSettings?: HarnessWorktreeSettings | undefined;
  resolveWorktreeSettings?(workspaceId: string, parent: ThreadParent): Promise<HarnessWorktreeSettings | undefined> | HarnessWorktreeSettings | undefined;
  workingStates?: WorkspaceWorkingStateRootAccess | undefined;
  executionViews?: ThreadExecutionViewRegistry | undefined;
  virtualWriteGate?: VirtualWriteGate | undefined;
  cloneAgentInputSnapshot?(sessionId: string, context: AgentInputContext): SurfaceSnapshotCloneResult;
  agentInputSurfaceOwner?(sessionId: string, context: AgentInputContext, workspaceId: string): { ownerId: string; generation: number; workspaceId: string } | null;
  sourceViews?: Pick<ReturnType<typeof createSourceViewStore>, "capture" | "contextFor" | "release">;
  resolveIntegrationCoordinator?(workspaceId: string): Promise<(Pick<IntegrationCoordinator, "mergeResult" | "previewResult" | "undoIntegration" | "invalidateWorkspace"> & Partial<Pick<IntegrationCoordinator, "invalidateThread">>) | null> | (Pick<IntegrationCoordinator, "mergeResult" | "previewResult" | "undoIntegration" | "invalidateWorkspace"> & Partial<Pick<IntegrationCoordinator, "invalidateThread">>) | null;
  canReclaimWorktree?(workspaceId: string, threadId: string, path: string): Promise<{ safe: boolean; reason?: string; release?: () => Promise<void> }>;
  hasActiveCommands?(directory: string): boolean | Promise<boolean>;
  verification?: VerificationCoordinator;
  onThreadSessionBound?(sessionId: string, owningScopeId: string): void;
}

export interface SpawnThreadRunInput extends CreateThreadInput {
  threadId: string;
  runId: string;
  promptText?: string;
}

export interface CapturedThreadDraftBaseline {
  draftBaselineId: string | null;
  sourceViewId: string | null;
  cleanup(): Promise<void>;
}

export interface PrepareIsolatedBranchInput {
  scopeId: string;
  parent: ThreadParent;
  threadId: string;
  draftBaselineId?: string | null;
  signal?: AbortSignal;
}

interface RuntimeBinding {
  scopeId: string;
  parent: ThreadParent;
  threadId: string;
  runId: string;
  sessionId: string;
  cwd: string;
  kind: Thread["kind"];
  providerId: string | null;
  baseline: {
    cost: number;
    toolCalls: number;
    tokens: { input: number; output: number; cacheRead: number };
  };
  /** Archive already received a successful provider abort+close; later capture steps may be retried without closing twice. */
  archiveStopConfirmed?: boolean;
}

export type ThreadRuntimeErrorCode = "conflict" | "invalid-request" | "not-found" | "unavailable";

export class ThreadRuntimeError extends Error {
  readonly code: ThreadRuntimeErrorCode;
  readonly retryable: boolean;

  constructor(code: ThreadRuntimeErrorCode, message: string, options: { cause?: unknown; retryable?: boolean } = {}) {
    super(message, options);
    this.name = "ThreadRuntimeError";
    this.code = code;
    this.retryable = options.retryable === true;
  }
}

export interface ThreadSessionScope {
  parent: ThreadParent;
  snapshot: SessionSnapshot | null;
  scopeId: string;
}

export interface ThreadMutationSnapshot {
  activeRun: ThreadRun;
  parent: ThreadParent;
  thread: Thread;
  scopeId: string;
}

interface AgentEndState {
  messages: PiMessage[];
  willRetry: boolean;
}

interface BrokerEventLike {
  kind: string;
  sessionId?: string;
  expected?: boolean;
  /** Broker worker role; worker.exit is only session loss for "session". */
  role?: string;
  envelope?: {
    kind?: string;
    event?: string;
    data?: unknown;
  };
}

const recordOf = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const LOOP_WINDOW = 6;
const DEFAULT_STALLED_AFTER_MS = 300_000;
export const DISCUSSION_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "glob",
  "explore",
  "related",
  "recall",
  "webfetch",
  "websearch",
  // `memory` also exposes remember/correct/forget. A read-only consult uses
  // `recall` for memory lookup; it must not receive the combined writer tool.
  "send",
  "wait",
  "threads",
  "read_thread",
]);
const THREAD_CONTROL_TOOLS = new Set(["dispatch", "threads", "wait", "send", "read_thread", "merge", "kill", "update"]);

const sameDirectory = (left: string, right: string): boolean => (
  normalizePathIdentity(left) === normalizePathIdentity(right)
);

/**
 * HR4: the manifest's frozen authority root is the durable identity of the
 * dispatch-time source. A child Run's clone/materialized worktree must still
 * resolve to that same directory identity; otherwise the frozen view would
 * silently address a different tree.
 */
const assertChildAuthorityRoot = async (
  frozenRoot: string,
  input: { authorityRoot: string; sessionRoot: string; worktree: Thread["worktree"] },
): Promise<void> => {
  if (!path.isAbsolute(frozenRoot) || !path.isAbsolute(input.authorityRoot)
    || !path.isAbsolute(input.sessionRoot)) {
    throw new ThreadRuntimeError("invalid-request", "Parent or child authority root is not absolute");
  }
  let parentIdentity: string;
  let childIdentity: string;
  let worktreeIdentity: string | null = null;
  try {
    [parentIdentity, childIdentity, worktreeIdentity] = await Promise.all([
      fs.promises.realpath(frozenRoot),
      fs.promises.realpath(input.authorityRoot),
      input.worktree ? fs.promises.realpath(input.worktree.path) : Promise.resolve(null),
    ]);
  } catch {
    throw new ThreadRuntimeError("unavailable", "Parent or child authority root is missing or inaccessible");
  }
  if (!sameDirectory(parentIdentity, childIdentity)
    && (!worktreeIdentity || !sameDirectory(worktreeIdentity, childIdentity))) {
    throw new ThreadRuntimeError("unavailable", "Frozen parent authority root cannot be mapped into the child authority root");
  }
};

const toolSignature = (name: unknown, args: unknown): string => createHash("sha256")
  .update(typeof name === "string" ? name : "unknown")
  .update("\0")
  .update(JSON.stringify(args ?? null))
  .digest("base64url");

interface AssistantReport {
  text: string;
  error: string | null;
}

const assistantConclusion = (messages: readonly PiMessage[]): AssistantReport => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n");
    const error = message.stopReason === "error" || message.stopReason === "aborted"
      ? message.errorMessage || message.stopReason
      : !text
        ? "thread finished without a text conclusion"
        : null;
    const fallback = text || message.errorMessage || "Thread finished without a text conclusion.";
    return { text: fallback, error };
  }
  return { text: "Thread finished without an assistant conclusion.", error: "thread settled without an assistant conclusion" };
};

const parentBlocksText = (blocks: Array<{ label: string; content: string }> | null | undefined): string | null => {
  if (blocks === undefined) return null;
  if (blocks === null) return '<parent-blocks status="unavailable" />';
  if (blocks.length === 0) return '<parent-blocks status="empty" />';
  return [
    '<parent-blocks note="Snapshot when this Run started; the parent may have progressed.">',
    ...blocks.flatMap((block) => [`[${block.label}]`, block.content]),
    "</parent-blocks>",
  ].join("\n");
};

const entryText = (entry: PiSessionMessageEntry): string => {
  if (entry.message.role === "user" || entry.message.role === "custom") {
    const content = entry.message.content;
    if (typeof content === "string") return content.trim();
    return content
      .filter((part) => part.type === "text")
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n");
  }
  if (entry.message.role === "assistant") {
    return entry.message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n");
  }
  return "";
};

const transcriptRefForRun = (
  entries: readonly { id: string }[],
  run: ThreadRun,
  runs: readonly ThreadRun[],
  sessionId: string,
): Pick<ThreadReport["transcriptRef"], "fromEntryId" | "toEntryId" | "branchLeafId"> => {
  const previous = runs
    .filter((candidate) => candidate.id !== run.id && candidate.attempt < run.attempt && candidate.sessionId === sessionId)
    .toSorted((left, right) => left.attempt - right.attempt)
    .at(-1);
  const previousTo = previous?.report?.transcriptRef.toEntryId;
  // A lost predecessor without durable transcript bounds makes the new
  // session window unknowable. Preserve that uncertainty instead of claiming
  // the old assistant output for the new Run.
  if (previous && !previousTo) {
    return { fromEntryId: null, toEntryId: null };
  }
  const previousIndex = previousTo ? entries.findIndex((entry) => entry.id === previousTo) : -1;
  if (previousTo && previousIndex < 0) return { fromEntryId: null, toEntryId: null };
  const first = previousIndex >= 0 ? entries[previousIndex + 1] : entries[0];
  const last = entries.at(-1);
  return {
    fromEntryId: first?.id ?? null,
    toEntryId: last?.id ?? null,
    ...(last?.id ? { branchLeafId: last.id } : {}),
  };
};

const inheritedContextText = (input: SpawnThreadRunInput): string | null => input.inheritedContext
  ? [
      `<inherited-context from-session="${input.inheritedContext.fromSessionId}" note="Parent input captured at dispatch; later messages are not included.">`,
      input.inheritedContext.text,
      "</inherited-context>",
    ].join("\n")
  : null;

const initialPrompt = (
  input: SpawnThreadRunInput,
  parentBlocks?: Array<{ label: string; content: string }> | null,
): string => [
  "You are a Varin agent in a child thread for a parent agent.",
  input.systemPromptFragment?.trim() || null,
  input.scope?.length ? `Scope: ${input.scope.join(", ")}` : null,
  parentBlocksText(parentBlocks),
  inheritedContextText(input),
  "",
  "Task:",
  input.promptText ?? input.brief,
].filter((line): line is string => line !== null).join("\n");

const messagePeerLabel = (peer: import("@varin/protocol").ThreadMessagePeer): string => (
  peer.kind === "thread" ? `thread ${peer.id}`
    : peer.kind === "user" ? "the user"
      : "the parent agent"
);

const pendingMessagesSection = (messages: readonly import("@varin/protocol").ThreadMessageRecord[]): string => (
  messages.map((message) => (
    `- ${messagePeerLabel(message.from)}${message.kind === "request" ? ` (request ${message.id})` : ""}: ${message.text}`
  )).join("\n")
);

const discussionPrompt = (
  input: SpawnThreadRunInput,
  parentBlocks?: Array<{ label: string; content: string }> | null,
): string => [
  input.createdBy === "user"
    ? "You are a Varin agent in a discussion thread opened by the user."
    : "You are a Varin agent in a consultation thread for the parent agent.",
  "This thread has read-only tools.",
  input.systemPromptFragment?.trim() || null,
  input.scope?.length ? `Scope: ${input.scope.join(", ")}` : null,
  parentBlocksText(parentBlocks),
  inheritedContextText(input),
  input.forkPoint
    ? [
        `<parent-message entry-id="${input.forkPoint.entryId}" note="Snapshot from the parent conversation.">`,
        input.promptText ?? input.brief,
        "</parent-message>",
      ].join("\n")
    : `Task:\n${input.promptText ?? input.brief}`,
].filter((line): line is string => line !== null).join("\n");

export function createThreadRuntime(options: ThreadRuntimeOptions) {
  const bindingsBySession = new Map<string, RuntimeBinding>();
  const sessionByThread = new Map<string, string>();
  const lastAgentEnd = new Map<string, AgentEndState>();
  const eventTails = new Map<string, Promise<void>>();
  const resuming = new Set<string>();
  const backgroundTasks = new Set<Promise<void>>();
  const autoResumedThreads = new Set<string>();
  // D-250: track the last materialization's CoW/reflink backend summary per
  // thread so inspectSpace can surface it through the existing ThreadOccupancy
  // consumer (no new dashboard).
  const cowByThread = new Map<string, { reflink: number; copy: number }>();
  const terminatingSessions = new Set<string>();
  const recentToolSignatures = new Map<string, string[]>();
  const stallTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const stalledThreads = new Set<string>();
  const waitingSessions = new Set<string>();
  const abortController = new AbortController();
  const mergeSignals = (left: AbortSignal, right?: AbortSignal): AbortSignal => {
    if (!right) return left;
    const any = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
    if (typeof any === "function") return any.call(AbortSignal, [left, right]);
    const merged = new AbortController();
    const abort = (): void => merged.abort();
    if (left.aborted || right.aborted) {
      merged.abort();
      return merged.signal;
    }
    left.addEventListener("abort", abort, { once: true });
    right.addEventListener("abort", abort, { once: true });
    return merged.signal;
  };

  const clearSwitchJournal = (worktree: NonNullable<Thread["worktree"]>): NonNullable<Thread["worktree"]> => {
    const next = { ...worktree };
    delete next.materializationSwitch;
    return next;
  };

  const persistWorktree = async (
    workspaceId: string,
    threadId: string,
    worktree: NonNullable<Thread["worktree"]>,
  ): Promise<void> => {
    await options.registry.setWorktree(workspaceId, threadId, worktree);
  };
  const ownershipAssertion = (worktree: NonNullable<Thread["worktree"]>) => async (
    operation: string,
    candidates: readonly string[] = [],
  ): Promise<void> => {
    if (!options.worktrees.assertOwnership) {
      throw new ThreadRuntimeError("unavailable", "Managed worktree ownership authority is unavailable");
    }
    await options.worktrees.assertOwnership(worktree, operation, candidates);
  };

  const recoverPersistedSwitch = async (input: {
    scopeId: string;
    threadId: string;
    worktree: NonNullable<Thread["worktree"]>;
    sourceRoot: string;
    signal: AbortSignal;
    intent: "abort" | "restart";
  }): Promise<NonNullable<Thread["worktree"]>> => {
    const journal = input.worktree.materializationSwitch;
    if (!journal) {
      await removeOrphanMaterializationDirs(input.worktree, ownershipAssertion(input.worktree));
      return input.worktree;
    }
    const outcome = await recoverMaterializationSwitch(input.worktree, journal, input.intent, ownershipAssertion(input.worktree));
    if (outcome === "materialized") {
      let executionBaseline = input.worktree.executionBaseline;
      if (options.worktrees.attachIsolatedGitContext) {
        try {
          input.signal.throwIfAborted();
          const attached = await options.worktrees.attachIsolatedGitContext(
            input.sourceRoot,
            input.worktree,
            input.signal,
          );
          if (attached.executionBaseline) executionBaseline = attached.executionBaseline;
        } catch (error) {
          await rollbackMaterializationSwitch(input.worktree, journal, ownershipAssertion(input.worktree));
          const rolled = clearSwitchJournal(input.worktree);
          await persistWorktree(input.scopeId, input.threadId, rolled);
          throw error;
        }
      }
      const completed = {
        ...clearSwitchJournal(input.worktree),
        viewMode: "materialized" as const,
        materialized: true,
        preparationStage: input.worktree.preparationStage === "setup" ? "setup" as const : "ready" as const,
        ...(executionBaseline ? { executionBaseline } : {}),
      };
      if (!executionBaseline) delete completed.executionBaseline;
      delete completed.materializationFingerprint;
      await persistWorktree(input.scopeId, input.threadId, completed);
      await fs.promises.rm(journal.backupPath, { recursive: true, force: true });
      await removeOrphanMaterializationDirs(completed, ownershipAssertion(completed));
      return completed;
    }
    const rolled = clearSwitchJournal(input.worktree);
    await persistWorktree(input.scopeId, input.threadId, rolled);
    return rolled;
  };
  const clearNativeMaterializationHandoff = (
    worktree: NonNullable<Thread["worktree"]>,
  ): NonNullable<Thread["worktree"]> => {
    const next = { ...worktree };
    delete next.materializationHandoff;
    return next;
  };

  const resumeNativeMaterializationHandoff = async (input: {
    scopeId: string;
    threadId: string;
    branchId: string;
    sourceRoot: string;
    worktree: NonNullable<Thread["worktree"]>;
    signal: AbortSignal;
  }): Promise<NonNullable<Thread["worktree"]>> => {
    if (!options.workingStates) throw new Error("Working-state authority is unavailable for native materialization recovery");
    const original = input.worktree.materializationHandoff;
    if (!original) return input.worktree;
    return options.workingStates.withBranchStore(
      input.scopeId,
      "thread-native-materialization-handoff",
      async (store) => {
        if (!store.materializePinManaged || !store.pinBranchHandoff || !store.openBranchHandoffPin || !store.releaseBranchHandoffPin) {
          throw new Error("Native materialization handoff requires the Rust WorkingState backend");
        }
        input.signal.throwIfAborted();
        if (original.view === "current") {
          const branch = await store.getBranchRoot(input.branchId, { signal: input.signal });
          if (!branch || branch.root !== original.root || branch.writeRevision !== original.writeRevision) {
            await store.releaseBranchHandoffPin(input.branchId, original.pinId);
            const conflicted = {
              ...clearNativeMaterializationHandoff(input.worktree),
              preparationStage: "materializing" as const,
              retentionReason: `Materialization source changed after intent ${original.operationId}; preserved directory requires explicit rebuild`,
            };
            await persistWorktree(input.scopeId, input.threadId, conflicted);
            throw new Error(`Materialization handoff no longer matches the current working root: ${input.branchId}@${original.writeRevision}`);
          }
        }
        let worktree = input.worktree;
        let handoff = worktree.materializationHandoff!;
        if (handoff.stage === "git-attached") {
          // Release is completed before the Registry intent is cleared. A
          // failed release leaves the durable receipt intact for restart.
          await store.releaseBranchHandoffPin(input.branchId, handoff.pinId);
          const completed = {
            ...clearNativeMaterializationHandoff(worktree),
            viewMode: "materialized" as const,
            materialized: true,
            preparationStage: handoff.nextPreparationStage,
            ...(handoff.executionBaseline ? { executionBaseline: handoff.executionBaseline } : {}),
          };
          if (!handoff.executionBaseline) delete completed.executionBaseline;
          delete completed.materializationFingerprint;
          delete completed.retentionReason;
          await persistWorktree(input.scopeId, input.threadId, completed);
          return completed;
        }
        let pin: WorkingStatePin | undefined;
        try {
          pin = await store.openBranchHandoffPin(
            input.branchId,
            original.pinId,
            { root: original.root, revision: original.revision, writeRevision: original.writeRevision },
            input.signal,
          );
        } catch (error) {
          if (!/pin not found/i.test(error instanceof Error ? error.message : String(error))) throw error;
          pin = await store.pinBranchHandoff(
            input.branchId,
            original.pinId,
            original.view === "revision"
              ? { revision: original.revision, signal: input.signal }
              : { signal: input.signal },
          );
          if (pin.root !== original.root || pin.revision !== original.revision || pin.writeRevision !== original.writeRevision) {
            await pin.release();
            pin = undefined;
            throw new Error(`Materialization handoff source identity changed: ${input.branchId}`);
          }
        }

        if (handoff.stage === "intent-persisted") {
          await ownershipAssertion(worktree)("resume native materialization", [worktree.path]);
          const materialized = await store.materializePinManaged(pin, worktree.path, handoff.operationId, input.signal);
          if (materialized.cow) cowByThread.set(input.threadId, materialized.cow);
          handoff = { ...handoff, stage: "kernel-materialized" };
          worktree = { ...worktree, materialized: true, preparationStage: "materializing", materializationHandoff: handoff };
          await persistWorktree(input.scopeId, input.threadId, worktree);
        }

        if (handoff.stage === "kernel-materialized") {
          input.signal.throwIfAborted();
          const attached = options.worktrees.attachIsolatedGitContext
            ? await options.worktrees.attachIsolatedGitContext(input.sourceRoot, worktree, input.signal)
            : { kind: "none" as const };
          handoff = {
            ...handoff,
            stage: "git-attached",
            gitKind: attached.kind,
            ...(attached.executionBaseline ? { executionBaseline: attached.executionBaseline } : {}),
          };
          worktree = { ...worktree, materializationHandoff: handoff };
          await persistWorktree(input.scopeId, input.threadId, worktree);
        }

        if (handoff.stage !== "git-attached") throw new Error("Native materialization handoff did not reach its Git receipt");
        await store.releaseBranchHandoffPin(input.branchId, handoff.pinId);
        pin = undefined;
        const completed = {
          ...clearNativeMaterializationHandoff(worktree),
          viewMode: "materialized" as const,
          materialized: true,
          preparationStage: handoff.nextPreparationStage,
          ...(handoff.executionBaseline ? { executionBaseline: handoff.executionBaseline } : {}),
        };
        if (!handoff.executionBaseline) delete completed.executionBaseline;
        delete completed.materializationFingerprint;
        delete completed.retentionReason;
        await persistWorktree(input.scopeId, input.threadId, completed);
        return completed;
      },
      "exclusive",
    );
  };

  interface PreparationTask {
    controller: AbortController;
    promise: Promise<unknown>;
    stage: string;
  }
  const preparations = new Map<string, PreparationTask>();
  const spaceMutationTails = new Map<string, Promise<void>>();
  const spaceReservations = new Map<string, Map<string, ReturnType<typeof measurementFromStates>>>();
  const pendingMaterializeReservations = new Map<string, () => Promise<void>>();
  const threadLifecycleTails = new Map<string, Promise<void>>();

  const releasePendingMaterializeReservation = async (threadId: string): Promise<void> => {
    const release = pendingMaterializeReservations.get(threadId);
    if (!release) return;
    pendingMaterializeReservations.delete(threadId);
    await release();
  };

  const reportError = (error: unknown): void => {
    try { options.onError?.(error); } catch { /* Diagnostics cannot break runtime state. */ }
  };

  const runPreparation = async <T>(
    threadId: string,
    operation: (signal: AbortSignal, setStage: (stage: string) => void) => Promise<T>,
  ): Promise<T> => {
    if (preparations.has(threadId)) throw new ThreadRuntimeError("conflict", `Thread preparation is already running: ${threadId}`);
    const controller = new AbortController();
    let stage = "starting";
    let resolvePromise!: (value: T) => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const task: PreparationTask = { controller, promise, get stage() { return stage; } };
    preparations.set(threadId, task);
    void (async () => {
      try {
        resolvePromise(await operation(controller.signal, (next) => { stage = next; }));
      } catch (error) {
        rejectPromise(error);
      } finally {
        if (preparations.get(threadId) === task) preparations.delete(threadId);
      }
    })();
    return promise;
  };

  const waitForPreparation = async (threadId: string): Promise<void> => {
    const preparation = preparations.get(threadId);
    if (!preparation) return;
    preparation.controller.abort();
    await preparation.promise.catch((error) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) reportError(error);
    });
  };

  // Budget checks and reclamation operate on the whole workspace. Serialize
  // their mutations at that same scope so two threads cannot both pass a
  // stale occupancy check and materialize over the configured budget.
  const withSpaceMutation = async <T>(workspaceId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = spaceMutationTails.get(workspaceId) ?? Promise.resolve();
    const next = previous.then(operation);
    const settled = next.then(() => undefined, () => undefined);
    spaceMutationTails.set(workspaceId, settled);
    try {
      return await next;
    } finally {
      if (spaceMutationTails.get(workspaceId) === settled) spaceMutationTails.delete(workspaceId);
    }
  };

  const withThreadLifecycle = async <T>(
    workspaceId: string,
    threadId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const key = `${workspaceId}\0${threadId}`;
    const previous = threadLifecycleTails.get(key) ?? Promise.resolve();
    const next = previous.then(operation);
    const settled = next.then(() => undefined, () => undefined);
    threadLifecycleTails.set(key, settled);
    try {
      return await next;
    } finally {
      if (threadLifecycleTails.get(key) === settled) threadLifecycleTails.delete(key);
    }
  };

  const tryWithThreadLifecycle = async (
    workspaceId: string,
    threadId: string,
    operation: () => Promise<void>,
  ): Promise<boolean> => {
    const key = `${workspaceId}\0${threadId}`;
    // This check and the following set are synchronous, so another lifecycle
    // operation cannot enter the same thread between them.
    if (threadLifecycleTails.has(key)) return false;
    const next = Promise.resolve().then(operation);
    const settled = next.then(() => undefined, () => undefined);
    threadLifecycleTails.set(key, settled);
    try {
      await next;
      return true;
    } finally {
      if (threadLifecycleTails.get(key) === settled) threadLifecycleTails.delete(key);
    }
  };

  const cascadingLifecycle = new Set<string>();
  const lifecycleKey = (workspaceId: string, threadId: string): string => `${workspaceId}\0${threadId}`;

  const beginCascade = async (workspaceId: string, threadId: string): Promise<() => void> => {
    const key = lifecycleKey(workspaceId, threadId);
    cascadingLifecycle.add(key);
    try {
      const releaseRegistry = typeof options.registry.beginCascade === "function"
        ? await options.registry.beginCascade(workspaceId, threadId)
        : () => undefined;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        cascadingLifecycle.delete(key);
        releaseRegistry();
      };
    } catch (error) {
      cascadingLifecycle.delete(key);
      throw error;
    }
  };

  const compareThreadsStable = (left: Thread, right: Thread): number => {
    const byCreated = left.createdAt.localeCompare(right.createdAt);
    return byCreated !== 0 ? byCreated : left.id.localeCompare(right.id);
  };

  const collectDescendantsPostOrder = async (workspaceId: string, threadId: string): Promise<Thread[]> => {
    const children = (await options.registry.listThreads(workspaceId, { kind: "thread", id: threadId }, true))
      .toSorted(compareThreadsStable);
    const ordered: Thread[] = [];
    for (const child of children) {
      ordered.push(...await collectDescendantsPostOrder(workspaceId, child.id));
      ordered.push(child);
    }
    return ordered;
  };

  const ancestorBlocksRestore = async (workspaceId: string, parent: ThreadParent): Promise<string | null> => {
    let current: ThreadParent | null = parent;
    while (current?.kind === "thread") {
      if (cascadingLifecycle.has(lifecycleKey(workspaceId, current.id))) return current.id;
      const ancestor = await options.registry.getThreadById(workspaceId, current.id);
      if (!ancestor || ancestor.lifecycle === "archived") return current.id;
      current = ancestor.parent;
    }
    return null;
  };

  const resolveWorkspaceIdForThread = (threadId: string): string | undefined => {
    const sessionId = sessionByThread.get(threadId);
    return sessionId ? bindingsBySession.get(sessionId)?.scopeId : undefined;
  };

  const assertMaterializationPathAvailable = async (directory: string): Promise<void> => {
    try {
      await fs.promises.lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const error = new Error(`Original thread path is occupied by other content: ${directory}`);
    (error as NodeJS.ErrnoException).code = "EEXIST";
    throw error;
  };

  const directoryFingerprint = async (directory: string): Promise<string> => {
    const hash = createHash("sha256");
    const visit = async (absolute: string, relative: string): Promise<void> => {
      const stat = await fs.promises.lstat(absolute);
      hash.update(relative.replace(/\\/g, "/"));
      hash.update("\0");
      hash.update(String(stat.mode & 0o7777));
      hash.update("\0");
      if (stat.isSymbolicLink()) {
        hash.update("link\0");
        hash.update(await fs.promises.readlink(absolute));
        return;
      }
      if (stat.isDirectory()) {
        hash.update("directory\0");
        const entries = await fs.promises.readdir(absolute, { withFileTypes: true });
        for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
          await visit(path.join(absolute, entry.name), relative ? `${relative}/${entry.name}` : entry.name);
        }
        return;
      }
      if (stat.isFile()) {
        hash.update("file\0");
        hash.update(await fs.promises.readFile(absolute));
        return;
      }
      hash.update("other\0");
      hash.update(String(stat.size));
    };
    await visit(directory, "");
    return hash.digest("base64url");
  };

  const observeMaterialization = async (directory: string): Promise<{ exists: false } | { exists: true; fingerprint: string }> => {
    try {
      return { exists: true, fingerprint: await directoryFingerprint(directory) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
      throw error;
    }
  };

  const preparationStageOf = (
    worktree: NonNullable<Thread["worktree"]>,
  ): NonNullable<NonNullable<Thread["worktree"]>["preparationStage"]> => (
    worktree.preparationStage ?? (worktree.materialized === false && worktree.viewMode !== "virtual" ? "materialize" : "ready")
  );

  const isVirtualWorktree = (worktree: Thread["worktree"] | undefined): boolean => (
    worktree?.viewMode === "virtual"
  );

  const usesWorkingBranchAuthority = (thread: Thread | null | undefined): boolean => Boolean(
    thread?.workBranchId
    && (isVirtualWorktree(thread.worktree) || thread.worktree?.materialized === false),
  );

  const bindExecutionView = async (input: {
    sessionId: string;
    scopeId: string;
    parent: ThreadParent;
    threadId: string;
    runId: string;
  }): Promise<void> => {
    if (!options.executionViews || !options.workingStates) return;
    const thread = await options.registry.getThread(input.scopeId, input.parent, input.threadId);
    if (!thread?.workBranchId) return;
    let worktree = thread.worktree;
    const recoveredHandoff = worktree?.materializationHandoff;
    if (worktree?.baselineUpdate) throw new ThreadRuntimeError("unavailable", `Finish baseline update ${worktree.baselineUpdate.operationId} before binding execution`);
    if (worktree?.materializationHandoff) {
      const sourceRoot = await options.resolveWorkspaceRoot(input.scopeId);
      worktree = await resumeNativeMaterializationHandoff({
        scopeId: input.scopeId, threadId: input.threadId, branchId: thread.workBranchId,
        worktree, sourceRoot, signal: abortController.signal,
      });
      if (worktree.preparationStage !== "ready") {
        throw new Error(`Materialized execution view is not ready after recovery: ${worktree.preparationStage ?? "unknown"}`);
      }
    }
    const recoveredJournal = worktree?.materializationSwitch;
    if (worktree?.materializationSwitch) {
      const sourceRoot = await options.resolveWorkspaceRoot(input.scopeId);
      worktree = await recoverPersistedSwitch({
        scopeId: input.scopeId,
        threadId: input.threadId,
        worktree,
        sourceRoot,
        signal: abortController.signal,
        intent: "restart",
      });
    }
    const bound = await options.workingStates.withBranchStore(
            input.scopeId,
      "working-branch-view-bind",
      async (store) => {
        const branch = await store.getBranchRoot(thread.workBranchId!);
        const recoveredIdentity = recoveredHandoff ?? recoveredJournal;
        const recoveredTracksCurrent = recoveredHandoff ? recoveredHandoff.view === "current" : Boolean(recoveredJournal);
        if (recoveredIdentity && worktree?.viewMode === "materialized"
          && recoveredTracksCurrent
          && (branch?.root !== recoveredIdentity.root || branch?.writeRevision !== recoveredIdentity.writeRevision)) {
          throw new Error(`Materialized working root no longer matches ${thread.workBranchId}@${recoveredIdentity.writeRevision}`);
        }
        return {
          draftBasePaths: branch?.draftBasePaths ?? [],
          writeRevision: recoveredIdentity && worktree?.viewMode === "materialized" ? recoveredIdentity.writeRevision : branch?.writeRevision ?? 0,
        };
      },
      "shared",
    );
    options.executionViews.bind({
      sessionId: input.sessionId,
      workspaceId: input.scopeId,
      threadId: input.threadId,
      runId: input.runId,
      branchId: thread.workBranchId,
      revision: (recoveredHandoff ?? recoveredJournal) && worktree?.viewMode === "materialized"
        ? (recoveredHandoff ?? recoveredJournal)!.revision
        : thread.resultRevision ?? 0,
      writeRevision: bound.writeRevision,
      mode: isVirtualWorktree(worktree) ? "virtual" : "materialized",
      draftBasePaths: bound.draftBasePaths,
    });
  };

  const unknownMeasurement = (): ReturnType<typeof measurementFromStates> => ({
    logicalBytes: null,
    allocatedBytes: null,
    unknown: true,
  });

  const estimateResultFootprint = async (
    workspaceId: string,
    thread: Thread | null,
    worktree: Thread["worktree"],
    sourceRoot?: string,
  ): Promise<ReturnType<typeof measurementFromStates>> => {
    if (thread?.workBranchId && thread.resultRevision && options.workingStates) {
      return options.workingStates.withBranchStore(workspaceId, "thread-result-budget-estimate", async (store) => {
        const result = await store.getResult(thread.workBranchId!, thread.resultRevision!);
        if (!result) return unknownMeasurement();
        const pin = await store.pinBranch(thread.workBranchId!, { revision: thread.resultRevision! });
        try { return await store.measurePin(pin); } finally { await pin.release(); }
      }, "shared");
    }
    if (worktree?.resultPath) return measureDirectory(worktree.resultPath).catch(() => unknownMeasurement());
    // A legacy retained result without a resultPath cannot be estimated from
    // the live parent workspace; treating that as the new directory would
    // charge unrelated files to the restore.
    if (sourceRoot && thread === null) {
      if (!options.worktrees.estimatePrepare) return unknownMeasurement();
      return options.worktrees.estimatePrepare(sourceRoot).catch(() => unknownMeasurement());
    }
    return unknownMeasurement();
  };

  const budgetFailureFor = async (
    workspaceId: string,
    parent: ThreadParent,
    settings: HarnessWorktreeSettings | undefined,
    additional: ReturnType<typeof measurementFromStates>,
    additionalThreadId = "",
  ): Promise<string | null> => {
    const budget = settings?.budget;
    if (!budget) return null;
    const space = await inspectSpace(workspaceId, parent);
    const occupancyByThread = new Map(space.threads.map((entry) => [entry.threadId, entry.materialized.logicalBytes]));
    const reservedKnown = [...(spaceReservations.get(workspaceId)?.entries() ?? [])].reduce((sum, [threadId, reservation]) => {
      if (reservation.logicalBytes === null || threadId === additionalThreadId) return sum;
      const alreadyMaterialized = occupancyByThread.get(threadId) ?? 0;
      return sum + Math.max(0, reservation.logicalBytes - alreadyMaterialized);
    }, 0);
    if (budget.maxBytes !== undefined) {
      const knownCurrent = space.threads.reduce((sum, thread) => (
        thread.materialized.logicalBytes === null ? sum : sum + thread.materialized.logicalBytes
      ), 0);
      const projected = knownCurrent + reservedKnown + (additional.logicalBytes ?? 0);
      if (projected > budget.maxBytes) {
        return `Configured worktree maxBytes would be exceeded by known occupancy (${projected} > ${budget.maxBytes})`;
      }
    }
    if (budget.minFreeRatio !== undefined) {
      let volume: { freeBytes: number; totalBytes: number } | null = null;
      try { volume = await readVolumeSpace(await options.resolveWorkspaceRoot(workspaceId)); } catch { volume = null; }
      if (volume && space.freeBytes !== null) {
        const projectedFree = Math.max(0, volume.freeBytes - reservedKnown - (additional.logicalBytes ?? 0));
        if (projectedFree / volume.totalBytes < budget.minFreeRatio) {
          return "Configured minimum free-space ratio would be exceeded by known occupancy";
        }
      }
    }
    return null;
  };

  const reserveMaterialization = async (
    workspaceId: string,
    parent: ThreadParent,
    threadId: string,
    settings: HarnessWorktreeSettings | undefined,
    additional: ReturnType<typeof measurementFromStates>,
    reclaimOthers = false,
  ): Promise<{ failure: string | null; release(): Promise<void> }> => {
    if (!settings?.budget) return { failure: null, release: async () => undefined };
    if (reclaimOthers || settings.reclaimIdle) {
      await reclaimEligibleOthers(workspaceId, parent, threadId);
    }
    return withSpaceMutation(workspaceId, async () => {
      const failure = await budgetFailureFor(workspaceId, parent, settings, additional, threadId);
      if (failure) return { failure, release: async () => undefined };
      const reservations = spaceReservations.get(workspaceId) ?? new Map();
      if (reservations.has(threadId)) {
        throw new ThreadRuntimeError("conflict", `Thread already has a worktree space reservation: ${threadId}`);
      }
      reservations.set(threadId, additional);
      spaceReservations.set(workspaceId, reservations);
      let released = false;
      return {
        failure: null,
        release: async () => {
          if (released) return;
          released = true;
          await withSpaceMutation(workspaceId, async () => {
            const current = spaceReservations.get(workspaceId);
            current?.delete(threadId);
            if (current?.size === 0) spaceReservations.delete(workspaceId);
          });
        },
      };
    });
  };

  const enqueue = (threadId: string, operation: () => Promise<void>): void => {
    const previous = eventTails.get(threadId) ?? Promise.resolve();
    const next = previous.then(operation).catch(reportError);
    const tracked = next.finally(() => {
      if (eventTails.get(threadId) === tracked) eventTails.delete(threadId);
    });
    eventTails.set(threadId, tracked);
  };

  const resolveEffectiveWorktreeSettings = async (workspaceId: string, parent: ThreadParent): Promise<HarnessWorktreeSettings | undefined> => {
    if (options.resolveWorktreeSettings) {
      const resolved = await options.resolveWorktreeSettings(workspaceId, parent);
      if (resolved) return resolved;
    }
    return options.worktreeSettings;
  };

  const resolveCaptureScopes = (sourceRoot: string, settings: HarnessWorktreeSettings | undefined): string[] => {
    const root = path.resolve(sourceRoot);
    return (settings?.copyIgnored ?? []).map((configuredPath) => {
      const absolute = path.resolve(root, configuredPath);
      const relative = path.relative(root, absolute).replace(/\\/g, "/");
      if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
        throw new ThreadRuntimeError("invalid-request", `harness.worktree.copyIgnored path is outside the workspace: ${configuredPath}`);
      }
      return relative;
    });
  };

  const recordIncompleteMaterialization = async (
    workspaceId: string,
    threadId: string,
    worktree: NonNullable<Thread["worktree"]>,
    reason: string,
  ): Promise<void> => {
    try {
      const observed = await observeMaterialization(worktree.path);
      if (observed.exists) {
        worktree.materialized = true;
        worktree.preparationStage = "materializing";
        worktree.materializationFingerprint = observed.fingerprint;
      } else {
        worktree.materialized = false;
        worktree.preparationStage = "materialize";
        delete worktree.materializationFingerprint;
      }
    } catch (error) {
      worktree.materialized = true;
      worktree.preparationStage = "materializing";
      delete worktree.materializationFingerprint;
      reportError(error);
    }
    worktree.retentionReason = reason;
    await persistWorktree(workspaceId, threadId, worktree).catch(reportError);
  };

  const clearIncompleteMaterialization = async (
    workspaceId: string,
    threadId: string,
    worktree: NonNullable<Thread["worktree"]>,
  ): Promise<void> => {
    const observed = await observeMaterialization(worktree.path);
    if (!observed.exists) {
      worktree.materialized = false;
      worktree.preparationStage = "materialize";
      delete worktree.materializationFingerprint;
      await persistWorktree(workspaceId, threadId, worktree);
      return;
    }
    if (!worktree.materializationFingerprint || worktree.materializationFingerprint !== observed.fingerprint) {
      const error = new Error(`Incomplete thread materialization contains new or unverified content: ${worktree.path}`);
      (error as NodeJS.ErrnoException).code = "EEXIST";
      throw error;
    }
    if (!options.worktrees.reclaim || !options.canReclaimWorktree) {
      throw new ThreadRuntimeError("unavailable", "The incomplete managed directory cannot be retried until its reclaim guard is available");
    }
    const permission = await options.canReclaimWorktree(workspaceId, threadId, worktree.path);
    try {
      if (!permission.safe) {
        throw new ThreadRuntimeError("unavailable", permission.reason ?? "The incomplete managed directory still has an active user or writer");
      }
      // The directory was first inspected before awaiting the guard. A
      // controlled writer may have completed during that wait, so the guarded
      // fingerprint is the one that authorizes deletion.
      const guarded = await observeMaterialization(worktree.path);
      if (!guarded.exists) {
        worktree.materialized = false;
        worktree.preparationStage = "materialize";
        delete worktree.materializationFingerprint;
        await persistWorktree(workspaceId, threadId, worktree);
        return;
      }
      if (!worktree.materializationFingerprint || guarded.fingerprint !== worktree.materializationFingerprint) {
        const error = new Error(`Incomplete thread materialization contains new or unverified content: ${worktree.path}`);
        (error as NodeJS.ErrnoException).code = "EEXIST";
        throw error;
      }
      const reclaimed = await options.worktrees.reclaim(worktree, { nativeVerified: true, workspaceId });
      if (!reclaimed.reclaimed) {
        throw new ThreadRuntimeError("unavailable", reclaimed.reason ?? "The incomplete managed directory could not be reclaimed for retry");
      }
    } finally {
      await permission.release?.();
    }
    worktree.materialized = false;
    worktree.preparationStage = "materialize";
    delete worktree.materializationFingerprint;
    await persistWorktree(workspaceId, threadId, worktree);
  };

  const materializeRecordedWorktree = async (input: {
    scopeId: string;
    threadId: string;
    sourceRoot: string;
    worktree: NonNullable<Thread["worktree"]>;
    branchId?: string;
    resultRevision?: number;
    setupRequired: boolean;
    signal: AbortSignal;
  }): Promise<NonNullable<Thread["worktree"]>> => {
    let worktree = input.worktree;
    if (worktree.materializationHandoff) {
      if (!input.branchId) throw new Error("Persisted native materialization handoff has no working branch");
      return resumeNativeMaterializationHandoff({
        scopeId: input.scopeId, threadId: input.threadId, branchId: input.branchId,
        sourceRoot: input.sourceRoot, worktree, signal: input.signal,
      });
    }
    if (preparationStageOf(worktree) === "materializing") {
      await clearIncompleteMaterialization(input.scopeId, input.threadId, worktree);
    }
    await assertMaterializationPathAvailable(worktree.path);
    if (!options.worktrees.materialize && !(input.branchId && options.workingStates)) {
      throw new Error("Thread worktree materialization is unavailable");
    }
    worktree.materialized = false;
    worktree.preparationStage = "materializing";
    delete worktree.materializationFingerprint;
    await persistWorktree(input.scopeId, input.threadId, worktree);
    try {
      let managedMaterialized = false;
      if (input.branchId && options.workingStates) {
        const fixed = await options.workingStates.withBranchStore(
          input.scopeId,
          "thread-recorded-materialize",
          async (store) => {
            if (!store.materializePinManaged || !store.pinBranchHandoff || !store.openBranchHandoffPin || !store.releaseBranchHandoffPin) return null;
            const pin = await store.pinBranch(input.branchId!, {
              ...(input.resultRevision === undefined ? {} : { revision: input.resultRevision }),
              signal: input.signal,
            });
            return { store, pin };
          },
        );
        if (fixed) {
          const handoff = {
            operationId: `working-recorded-materialize:${randomUUID()}`,
            pinId: `working-recorded-materialize-pin:${randomUUID()}`,
            revision: fixed.pin.revision,
            writeRevision: fixed.pin.writeRevision,
            root: fixed.pin.root,
            view: fixed.pin.view,
            nextPreparationStage: input.setupRequired ? "setup" as const : "ready" as const,
            stage: "intent-persisted" as const,
          };
          worktree = { ...worktree, materializationHandoff: handoff, preparationStage: "materializing", materialized: false };
          await persistWorktree(input.scopeId, input.threadId, worktree);
          try {
            worktree = await resumeNativeMaterializationHandoff({
              scopeId: input.scopeId, threadId: input.threadId, branchId: input.branchId,
              sourceRoot: input.sourceRoot, worktree, signal: input.signal,
            });
          } finally {
            await fixed.pin.release().catch(reportError);
          }
          managedMaterialized = true;
        }
      }
      if (!managedMaterialized) {
        worktree = await options.worktrees.materialize!(input.sourceRoot, worktree, input.signal);
        if (input.branchId && input.resultRevision !== undefined && options.workingStates) {
          const overlaid = await options.workingStates.withBranchStore(
            input.scopeId,
            "thread-recorded-materialize-legacy-overlay",
            (store) => store.materializeResult(input.branchId!, input.resultRevision!, worktree.path),
          );
          if (overlaid?.cow) cowByThread.set(input.threadId, overlaid.cow);
        }
      }
      worktree.materialized = true;
      worktree.preparationStage = "materializing";
      await persistWorktree(input.scopeId, input.threadId, worktree);
      worktree.preparationStage = input.setupRequired ? "setup" : "ready";
      delete worktree.materializationFingerprint;
      delete worktree.retentionReason;
      await persistWorktree(input.scopeId, input.threadId, worktree);
      if (input.signal.aborted) throw new DOMException("Thread preparation aborted", "AbortError");
      return worktree;
    } catch (error) {
      if (preparationStageOf(worktree) !== "ready" && preparationStageOf(worktree) !== "setup") {
        await recordIncompleteMaterialization(
          input.scopeId,
          input.threadId,
          worktree,
          `Directory materialization did not complete: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }
  };

  const parentSession = async (workspaceId: string, parent: ThreadParent): Promise<{ id: string; file: string; cwd: string }> => {
    let sessionId: string;
    if (parent.kind === "session") sessionId = parent.id;
    else {
      const parentRun = await options.registry.getActiveRun(workspaceId, parent.id);
      if (!parentRun?.sessionId) throw new Error(`Parent thread has no Pi session: ${parent.id}`);
      sessionId = parentRun.sessionId;
    }
    const summary = await options.sessions.summary(sessionId);
    if (!summary.sessionFile) throw new Error(`Parent Pi session is not persisted: ${sessionId}`);
    return { id: sessionId, file: summary.sessionFile, cwd: summary.cwd };
  };

  const rootScopeForSession = async (sessionId: string): Promise<ThreadSessionScope> => {
    let snapshot: SessionSnapshot | null = null;
    let summary: SessionSummary | null = null;
    try {
      snapshot = await options.sessions.snapshot(sessionId);
    } catch (snapshotError) {
      try {
        summary = await options.sessions.summary(sessionId);
      } catch {
        throw snapshotError;
      }
    }
    const workspace = snapshot?.workspace ?? summary?.workspace;
    if (workspace?.kind !== "workspace") {
      // HR0: an unbound session is its own durable owner scope. Threads stay
      // addressable without a directory classification.
      return {
        scopeId: sessionScopeId(sessionId),
        parent: { kind: "session", id: sessionId },
        snapshot,
      };
    }
    return {
      scopeId: workspace.authorityId ?? workspace.id,
      parent: { kind: "session", id: sessionId },
      snapshot,
    };
  };

  const scopeForSession = async (sessionId: string): Promise<ThreadSessionScope> => {
    const root = await rootScopeForSession(sessionId);
    const bound = bindingsBySession.get(sessionId);
    if (bound) {
      return {
        scopeId: bound.scopeId,
        parent: { kind: "thread", id: bound.threadId },
        snapshot: root.snapshot,
      };
    }
    const persisted = await options.registry.getSessionBinding(sessionId);
    if (persisted) {
      return {
        scopeId: persisted.owningScopeId,
        parent: { kind: "thread", id: persisted.threadId },
        snapshot: root.snapshot,
      };
    }
    return root;
  };

  const bind = (binding: RuntimeBinding): void => {
    bindingsBySession.set(binding.sessionId, binding);
    sessionByThread.set(binding.threadId, binding.sessionId);
    recentToolSignatures.delete(`${binding.scopeId}\0${binding.threadId}`);
    options.verification?.attachThreadSession(binding.sessionId, {
      workspaceId: binding.scopeId,
      threadId: binding.threadId,
      runId: binding.runId,
      worktreePath: binding.cwd,
      captureIdentity: async () => {
        if (!options.workingStates) return { treeHash: null, reason: "WorkingState is unavailable" };
        const thread = await options.registry.getThread(binding.scopeId, binding.parent, binding.threadId);
        if (!thread?.worktree || !thread.workBranchId) return { treeHash: null, reason: "Thread worktree identity is unavailable" };
        if (thread.worktree.base === "zero-commit") {
          return { treeHash: null, reason: "Non-Git command identity is not captured without a full directory scan" };
        }
        const inspected = await options.worktrees.inspect(thread.worktree, "live");
        const treeHash = await options.workingStates.withBranchStore(
          binding.scopeId,
          "thread-command-input-identity",
          (store) => store.captureBranchCandidateIdentity(
            thread.workBranchId!,
            thread.worktree!.path,
            inspected.changedFiles,
          ),
          "shared",
        );
        return treeHash
          ? { treeHash }
          : { treeHash: null, reason: "Thread branch identity is unavailable" };
      },
    });
    void options.registry.getThread(binding.scopeId, binding.parent, binding.threadId).then((thread) => {
      options.verification?.updateChildBinding(binding.sessionId, {
        worktreePath: thread?.worktree?.path ?? binding.cwd,
        ...(thread?.workBranchId ? { branchId: thread.workBranchId } : {}),
      });
    }).catch(reportError);
  };

  const clearStallTimer = (sessionId: string): void => {
    const timer = stallTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    stallTimers.delete(sessionId);
  };

  const scheduleStallTimer = (binding: RuntimeBinding): void => {
    clearStallTimer(binding.sessionId);
    const delay = options.stalledAfterMs?.(binding.providerId) ?? DEFAULT_STALLED_AFTER_MS;
    const timer = setTimeout(() => {
      stallTimers.delete(binding.sessionId);
      if (bindingsBySession.get(binding.sessionId) !== binding) return;
      const key = `${binding.scopeId}\0${binding.threadId}`;
      stalledThreads.add(key);
      enqueue(binding.threadId, async () => {
        const [thread, run] = await Promise.all([
          options.registry.getThread(binding.scopeId, binding.parent, binding.threadId),
          options.registry.getActiveRun(binding.scopeId, binding.threadId),
        ]);
        if (
          thread?.attention === "none"
          && run?.id === binding.runId
          && run.outcome === null
        ) await options.registry.setAttention(binding.scopeId, binding.threadId, "stalled");
      });
    }, delay);
    timer.unref?.();
    stallTimers.set(binding.sessionId, timer);
  };

  const markAgentActivity = (binding: RuntimeBinding): void => {
    scheduleStallTimer(binding);
    const key = `${binding.scopeId}\0${binding.threadId}`;
    if (!stalledThreads.delete(key)) return;
    enqueue(binding.threadId, async () => {
      const thread = await options.registry.getThread(binding.scopeId, binding.parent, binding.threadId);
      if (thread?.attention === "stalled") {
        await options.registry.setAttention(binding.scopeId, binding.threadId, "none");
      }
    });
  };

  const clearWaitingAttention = (binding: RuntimeBinding): void => {
    if (!waitingSessions.delete(binding.sessionId)) return;
    enqueue(binding.threadId, async () => {
      const thread = await options.registry.getThread(binding.scopeId, binding.parent, binding.threadId);
      if (thread?.attention === "user" || thread?.attention === "permission") {
        await options.registry.setAttention(binding.scopeId, binding.threadId, "none");
      }
    });
  };

  const closeBinding = async (binding: RuntimeBinding, abort: boolean): Promise<void> => {
    terminatingSessions.add(binding.sessionId);
    if (abort) {
      try { await options.sessions.abort(binding.sessionId); } catch (error) { reportError(error); }
    }
    try {
      await options.sessions.close(binding.sessionId);
    } catch (error) {
      reportError(error);
      // The binding is the only authoritative route back to this live Pi
      // session. Keep it (and the terminating marker) until a later close is
      // actually confirmed.
      throw new ThreadRuntimeError(
        "unavailable",
        `Unable to close thread session: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (bindingsBySession.get(binding.sessionId) === binding) bindingsBySession.delete(binding.sessionId);
    if (sessionByThread.get(binding.threadId) === binding.sessionId) sessionByThread.delete(binding.threadId);
    await options.registry.unbindRunSession(binding.sessionId).catch(reportError);
    options.verification?.detachSession(binding.sessionId);
    options.executionViews?.unbind(binding.sessionId);
    lastAgentEnd.delete(binding.sessionId);
    clearStallTimer(binding.sessionId);
    stalledThreads.delete(`${binding.scopeId}\0${binding.threadId}`);
    waitingSessions.delete(binding.sessionId);
    terminatingSessions.delete(binding.sessionId);
  };

  const materializedPublishPaths = async (
    store: WorkingStateRootStore,
    branchId: string,
    directory: string,
    gitChangedPaths: readonly string[] | undefined,
  ): Promise<string[] | undefined> => {
    if (gitChangedPaths === undefined) return undefined;
    const branch = await store.getBranchRoot(branchId);
    if (!branch) throw new Error(`Working branch not found: ${branchId}`);
    if (branch.captureScopes.length === 0) return [...new Set(gitChangedPaths)].sort();
    const [currentScopePaths, priorScope] = await Promise.all([
      store.listCaptureScopePaths(directory, branch.captureScopes),
      store.listPaths(branchId, branch.captureScopes),
    ]);
    return [...new Set([
      ...gitChangedPaths,
      ...currentScopePaths,
      ...(priorScope?.entries.map((entry) => entry.path) ?? []),
    ])].sort();
  };

  const publishPartialResult = async (workspaceId: string, parent: ThreadParent, threadId: string): Promise<void> => {
    const thread = await options.registry.getThread(workspaceId, parent, threadId);
    if (thread?.preset === "retrieval") return;
    if (!thread?.worktree || !thread.workBranchId || !options.workingStates) return;
    if (thread.worktree.baselineUpdate) {
      throw new ThreadRuntimeError("unavailable", `Finish baseline update ${thread.worktree.baselineUpdate.operationId} before publishing a partial result`);
    }
    const result = isVirtualWorktree(thread.worktree)
      ? await options.workingStates.withBranchStore(workspaceId, "thread-partial-result-publish", (store) => store.publishHeadResult(thread.workBranchId!))
      : await (async () => {
        const inspected = thread.worktree!.base === "zero-commit"
          ? null
          : await options.worktrees.inspect(thread.worktree!, "live");
        const indexModes = await options.worktrees.inspectIndexModes?.(thread.worktree!.path);
        return options.workingStates!.withBranchStore(
          workspaceId,
          "thread-partial-result-publish",
          async (store) => {
            const paths = await materializedPublishPaths(
              store,
              thread.workBranchId!,
              thread.worktree!.path,
              inspected?.changedFiles,
            );
            return store.publishDirectoryResult(
              thread.workBranchId!,
              thread.worktree!.path,
              paths,
              indexModes === undefined ? {} : { indexModes },
            );
          },
          "exclusive",
          { executionWorkspace: await options.resolveRuntimeWorkspaceId(thread.worktree!.path) },
        );
      })();
    let worktree = thread.worktree;
    if (!result.root) {
      try {
        worktree = await options.worktrees.snapshot(worktree);
      } catch (error) {
        reportError(error);
        // Test/legacy stores without a native immutable result still need their
        // own fixed snapshot. A Rust result root is already the retained archive.
        throw new ThreadRuntimeError(
          "unavailable",
          `Unable to snapshot the thread worktree before archive: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
    await options.registry.setWorkingState(workspaceId, threadId, {
      branchId: thread.workBranchId,
      resultRevision: result.resultRevision,
      worktree,
      diffStats: result.diffStats,
    });
  };

  const captureDraftBaseline = async (
    sessionId: string,
    workspaceId: string,
    context: AgentInputContext,
  ): Promise<CapturedThreadDraftBaseline> => {
    const empty = { draftBaselineId: null, sourceViewId: null, cleanup: async () => undefined };
    if (context.source === "disk") return empty;
    if (context.snapshot.status === "unavailable") {
      if (context.roots.length === 0 || context.roots.some((root) => root.workspaceId === workspaceId && root.dirtyPaths.length > 0)) {
        throw new ThreadRuntimeError("unavailable", "The worktree source snapshot is unavailable; its dirty files cannot be safely inherited");
      }
      if (!options.sourceViews) throw new ThreadRuntimeError("unavailable", "Fixed external source storage is unavailable");
      const fixed = await options.sourceViews.capture({ status: "ready", resources: [], supersededResources: [] }, workspaceId,
        context.roots.flatMap((root) => root.dirtyPaths.map((resourceId) => ({ workspaceId: root.workspaceId, resourceId }))));
      return fixed ? {
        draftBaselineId: null,
        sourceViewId: fixed.viewId,
        cleanup: () => options.sourceViews!.release(fixed.viewId),
      } : empty;
    }
    if (!options.cloneAgentInputSnapshot) {
      throw new ThreadRuntimeError("unavailable", "The application host cannot clone editor source snapshots");
    }
    const cloned = options.cloneAgentInputSnapshot(sessionId, context);
    if (cloned.status !== "ready") {
      throw new ThreadRuntimeError("unavailable", cloned.status === "unavailable"
        ? cloned.message
        : "The editor source snapshot is unavailable");
    }
    const targetResources = [...new Map(cloned.resources.flatMap((resource) =>
      (resource.aliases ?? [resource.resource])
        .filter((alias) => alias.workspaceId === workspaceId)
        .map((alias) => [alias.resourceId, { ...resource, resource: alias }] as const)
    )).values()];
    const requestedPaths = [...(context.roots.find((root) => root.workspaceId === workspaceId)?.dirtyPaths ?? [])].sort();
    // A path written during this turn is answered from disk, which the Run
    // materializes anyway; overlaying its older draft would undo that write.
    // Completeness is still verified: every requested path must be accounted
    // for as either a cloned draft or a superseded one (D-088).
    const clonedPaths = [
      ...targetResources.map((resource) => resource.resource.resourceId),
      ...cloned.supersededResources.filter((resource) => resource.workspaceId === workspaceId).map((resource) => resource.resourceId),
    ].sort();
    if (clonedPaths.length !== requestedPaths.length
      || clonedPaths.some((file, index) => file !== requestedPaths[index])) {
      throw new ThreadRuntimeError("unavailable", "The editor source snapshot no longer matches the dispatch context");
    }
    const hasExternal = cloned.resources.some((resource) =>
      (resource.aliases ?? [resource.resource]).some((alias) => alias.workspaceId !== workspaceId));
    if (hasExternal && !options.sourceViews) throw new ThreadRuntimeError("unavailable", "Fixed external source storage is unavailable");
    const externalWorkspaceIds = [...new Set(cloned.resources.flatMap((resource) =>
      (resource.aliases ?? [resource.resource]).map((alias) => alias.workspaceId)
    ))].filter((id) => id !== workspaceId);
    const owners = externalWorkspaceIds.flatMap((id) => {
      const owner = options.agentInputSurfaceOwner?.(sessionId, context, id);
      return owner ? [owner] : [];
    });
    const fixed = hasExternal ? await options.sourceViews!.capture(cloned, workspaceId, [], owners) : null;
    if (targetResources.length === 0) return fixed ? {
      draftBaselineId: null,
      sourceViewId: fixed.viewId,
      cleanup: () => options.sourceViews!.release(fixed.viewId),
    } : empty;
    if (!options.workingStates) {
      if (fixed) await options.sourceViews!.release(fixed.viewId);
      throw new ThreadRuntimeError("unavailable", "Persistent working state is unavailable for editor drafts");
    }
    let baseline;
    try {
      baseline = await options.workingStates.withBranchStore(workspaceId, "thread-draft-baseline-capture", (store) => (
        store.createDraftBaseline(workspaceId, targetResources.map((resource) => ({
        path: resource.resource.resourceId,
        content: encodeDocumentText({
          content: resource.content,
          encoding: resource.encoding,
          bom: resource.bom,
        }),
        provenance: {
          baseRevision: resource.baseRevision,
          encoding: resource.encoding,
          bom: resource.bom,
          localEditRevision: resource.localEditRevision,
          revision: resource.revision,
        },
        })))
      ));
    } catch (error) {
      if (fixed) await options.sourceViews!.release(fixed.viewId);
      throw error;
    }
    return {
      draftBaselineId: baseline.id,
      sourceViewId: fixed?.viewId ?? null,
      cleanup: async () => {
        await options.workingStates!.withBranchStore(workspaceId, "thread-draft-baseline-create-failed", (store) => store.deleteDraftBaseline(baseline.id));
        if (fixed) await options.sourceViews!.release(fixed.viewId);
      },
    };
  };

  const prepareIsolatedBranchCore = async (
    input: PrepareIsolatedBranchInput,
    preparationSignal: AbortSignal,
    setPreparationStage: (stage: string) => void,
  ): Promise<{ branchId: string; worktree: NonNullable<Thread["worktree"]> }> => {
    if (!options.workingStates) {
      throw new ThreadRuntimeError("unavailable", "Persistent working state is unavailable for the isolated baseline");
    }
    const existing = await options.registry.getThread(input.scopeId, input.parent, input.threadId);
    if (!existing) throw new ThreadRuntimeError("not-found", `Thread not found: ${input.threadId}`);
    if (existing.workBranchId && existing.worktree) {
      return { branchId: existing.workBranchId, worktree: existing.worktree };
    }
    let sourceRoot = await options.resolveWorkspaceRoot(input.scopeId);
    let parentVirtualBranchId: string | null = null;
    if (input.parent.kind === "thread") {
      const owner = await options.registry.getThreadById(input.scopeId, input.parent.id);
      if (!owner) throw new ThreadRuntimeError("not-found", `Parent thread not found: ${input.parent.id}`);
      if (usesWorkingBranchAuthority(owner)) {
        parentVirtualBranchId = owner.workBranchId!;
      } else if (owner.worktree?.path && owner.worktree.materialized !== false && !isVirtualWorktree(owner.worktree)) {
        sourceRoot = owner.worktree.path;
      }
    }
    const captureWorkspaceId = await options.resolveRuntimeWorkspaceId(sourceRoot);
    const effectiveSettings = await resolveEffectiveWorktreeSettings(input.scopeId, input.parent);
    const inheritNestedCaptureScopes = async (): Promise<string[] | null> => {
      if (input.parent.kind !== "thread") return null;
      const owner = await options.registry.getThreadById(input.scopeId, input.parent.id);
      if (!owner?.workBranchId || !options.workingStates) return [];
      return options.workingStates.withBranchStore(
                input.scopeId,
        "thread-nested-capture-scopes",
        async (store) => {
          const branch = await store.getBranchRoot(owner.workBranchId!);
          if (!branch) throw new Error(`Parent working branch is unavailable: ${owner.workBranchId}`);
          return [...branch.captureScopes];
        },
        "shared",
      );
    };
    const inheritedScopes = await inheritNestedCaptureScopes();
    let captureScopes = inheritedScopes ?? resolveCaptureScopes(sourceRoot, effectiveSettings);
    const threadScope = existing.manifest.scope;
    if (inheritedScopes && threadScope.length > 0) {
      captureScopes = captureScopes.filter((scope) => (
        threadScope.some((root) => scopePathContainedBy(root, scope))
      ));
    }
    const draftBaselineId = input.draftBaselineId ?? existing.manifest.draftBaselineId ?? null;
    let worktree = existing.worktree;
    if (!worktree) {
      setPreparationStage("preparing-worktree");
      const prep = await options.worktrees.prepare({
        mode: "isolated",
        viewMode: "virtual",
        sourceRoot,
        threadId: input.threadId,
        signal: preparationSignal,
        onWorktreeState: async (candidate) => {
          candidate.viewMode = "virtual";
          candidate.materialized = false;
          candidate.preparationStage = "capturing-baseline";
          await options.registry.setWorktree(input.scopeId, input.threadId, candidate);
        },
      });
      if (!prep.worktree) {
        throw new ThreadRuntimeError("unavailable", "An isolated worktree was not created for the branch baseline");
      }
      worktree = prep.worktree;
    }
    worktree.viewMode = "virtual";
    worktree.materialized = false;
    if (existing.preset === "retrieval") worktree.readOnlyInput = true;
    worktree.preparationStage = "capturing-baseline";
    delete worktree.materializationFingerprint;
    await options.registry.setWorktree(input.scopeId, input.threadId, worktree);
    if (preparationSignal.aborted) throw new DOMException("Thread baseline capture aborted", "AbortError");
    setPreparationStage("capturing-baseline");
    const branchId = `thread-${input.threadId}`;
    const baselineChanged = (detail: string): ThreadRuntimeError => new ThreadRuntimeError(
      "unavailable",
      `Thread baseline is unavailable because the parent workspace changed during capture (baseline-changed): ${detail}`,
      { retryable: true },
    );
    const assertNoActiveBaselineWriters = async (): Promise<void> => {
      if (typeof options.inspectBaselineWriters !== "function") return;
      const writers = await options.inspectBaselineWriters(captureWorkspaceId, sourceRoot);
      if (writers.length > 0) {
        throw baselineChanged(`active writer ${writers.map((writer) => writer.id).join(", ")}`);
      }
    };
    const rejectGitlinks = (gitlinks: readonly string[]): void => {
      if (gitlinks.length === 0) return;
      throw new ThreadRuntimeError(
        "unavailable",
        `Thread baseline cannot capture Git submodule paths: ${gitlinks.join(", ")}`,
      );
    };
    const directoryWindow = async (store: { listWorkspaceBaselinePaths?(directory: string): Promise<string[]> }): Promise<string | null> => {
      if (typeof store.listWorkspaceBaselinePaths !== "function") return null;
      const paths = await store.listWorkspaceBaselinePaths(sourceRoot);
      return directoryBaselineFingerprint(paths);
    };
    const inspectInventory = async (): Promise<GitBaselineInventory | { kind: "directory" } | null> => {
      if (typeof options.worktrees.inspectGitBaselineInventory !== "function") return null;
      return options.worktrees.inspectGitBaselineInventory(sourceRoot, preparationSignal);
    };
    const createFromStates = async (
      store: WorkingStateRootStore,
      states: Record<string, RecoveryState>,
      baseRef: string,
    ): Promise<void> => {
      if (!draftBaselineId) {
        await store.createBranch(input.scopeId, branchId, states, baseRef, [], captureScopes);
        return;
      }
      const draftBaseline = await store.getDraftBaseline(draftBaselineId);
      if (!draftBaseline) throw new Error(`Thread draft baseline not found: ${draftBaselineId}`);
      const drafts = await Promise.all(Object.entries(draftBaseline.pathStates).map(async ([file, state]) => {
        if (state.kind !== "regular-file") throw new Error(`Thread draft baseline contains a non-file state: ${file}`);
        const content = await store.getObject(state.objectHash);
        if (!content) throw new Error(`Thread draft baseline content is missing: ${file}`);
        return { path: file, content, ...(state.mode === undefined ? {} : { mode: state.mode }) };
      }));
      await createBranchWithDraftBaseline(
        store,
        input.scopeId,
        branchId,
        states,
        drafts,
        baseRef,
        captureScopes,
      );
    };
    let baselineCapture: unknown;
    let dirtyBarrier: Awaited<ReturnType<NonNullable<ThreadRuntimeOptions["beginDirtyStateBarrier"]>>> | undefined;
    try {
      if (typeof options.beginDirtyStateBarrier === "function") {
        dirtyBarrier = await options.beginDirtyStateBarrier(captureWorkspaceId, ["."]);
      }
      if (typeof options.beginBaselineCapture === "function") {
        baselineCapture = await options.beginBaselineCapture(captureWorkspaceId);
      }
      await assertNoActiveBaselineWriters();
      await options.workingStates.withBranchStore(input.scopeId, "thread-baseline-capture", async (store) => {
        if (parentVirtualBranchId) {
          const parentBranch = await store.getBranchRoot(parentVirtualBranchId);
          if (!parentBranch) {
            throw new Error(`Parent working branch is unavailable: ${parentVirtualBranchId}`);
          }
          const beforeRevision = parentBranch.writeRevision;
          const baseRef = `thread-${input.parent.id}@${beforeRevision}`;
          worktree!.base = baseRef;
          if (typeof options.completeBaselineCapture === "function" && baselineCapture !== undefined) {
            const completed = await options.completeBaselineCapture(baselineCapture);
            baselineCapture = undefined;
            if (!completed.stable) {
              throw baselineChanged(`documents capture ${completed.reasons.join(",") || "unstable"}`);
            }
          }
          const pin = await store.pinBranch(parentVirtualBranchId, { signal: preparationSignal });
          try {
            if (pin.writeRevision !== beforeRevision || pin.root !== parentBranch.root) {
              throw baselineChanged(`parent writeRevision ${String(beforeRevision)} changed before pin`);
            }
            await store.createBranchFromPin(input.scopeId, branchId, pin, baseRef, draftBaselineId, captureScopes);
          } finally {
            await pin.release();
          }
          const after = await store.getBranchRoot(parentVirtualBranchId);
          if (!after || after.writeRevision !== beforeRevision || after.root !== parentBranch.root) {
            throw baselineChanged(`parent writeRevision ${String(beforeRevision)} -> ${String(after?.writeRevision ?? "missing")}`);
          }
          await assertNoActiveBaselineWriters();
          return;
        }
        const beforeInventory = await inspectInventory();
        let relativePaths: string[] | undefined;
        let baseRef = worktree!.base;
        let gitWindow: string | null = null;
        let directoryBefore: string | null = null;
        let frozenCaptureScopePaths: string[] = [];
        const canListCaptureScopes = typeof store.listCaptureScopePaths === "function";
        if (beforeInventory?.kind === "git") {
          rejectGitlinks(beforeInventory.gitlinks);
          const scopePaths = captureScopes.length > 0 && canListCaptureScopes
            ? await store.listCaptureScopePaths(sourceRoot, captureScopes)
            : [];
          frozenCaptureScopePaths = [...new Set(scopePaths)].sort();
          relativePaths = withAncestorDirectories([...beforeInventory.paths, ...scopePaths]);
          baseRef = beforeInventory.baseRef;
          worktree!.base = beforeInventory.baseRef;
          gitWindow = gitBaselineFingerprint(beforeInventory);
        } else {
          if (captureScopes.length > 0 && canListCaptureScopes) {
            frozenCaptureScopePaths = [...new Set(await store.listCaptureScopePaths(sourceRoot, captureScopes))].sort();
          }
          directoryBefore = await directoryWindow(store);
        }
        const baseline = await store.captureDirectory(sourceRoot, relativePaths, {
          signal: preparationSignal,
          ...(beforeInventory?.kind === "git" ? { indexModes: beforeInventory.indexModes } : {}),
          onProgress: (done, total) => {
            worktree!.retentionReason = `Capturing baseline ${done}/${total}`;
          },
        });
        delete worktree!.retentionReason;
        if (gitWindow !== null) {
          const afterInventory = await inspectInventory();
          if (afterInventory?.kind !== "git") throw baselineChanged("git workspace identity");
          rejectGitlinks(afterInventory.gitlinks);
          if (gitBaselineFingerprint(afterInventory) !== gitWindow) throw baselineChanged("git inventory");
        } else {
          const directoryAfter = await directoryWindow(store);
          if (directoryBefore !== null && directoryAfter !== null && directoryBefore !== directoryAfter) {
            throw baselineChanged("directory paths");
          }
        }
        const capturedPaths = Object.keys(baseline).sort();
        if (capturedPaths.length > 0) {
          const afterStates = await store.captureDirectory(sourceRoot, capturedPaths, {
            signal: preparationSignal,
            store: false,
            ...(beforeInventory?.kind === "git" ? { indexModes: beforeInventory.indexModes } : {}),
          });
          const changedPaths = capturedPaths.filter((file) => !sameState(
            baseline[file] ?? { kind: "missing" },
            afterStates[file] ?? { kind: "missing" },
          ));
          if (changedPaths.length > 0) {
            throw baselineChanged(`captured content or metadata: ${changedPaths.slice(0, 8).join(",")}`);
          }
        }
        if (canListCaptureScopes && (frozenCaptureScopePaths.length > 0 || captureScopes.length > 0)) {
          const afterScopePaths = [...new Set(await store.listCaptureScopePaths(sourceRoot, captureScopes))].sort();
          if (afterScopePaths.length !== frozenCaptureScopePaths.length
            || afterScopePaths.some((file, index) => file !== frozenCaptureScopePaths[index])) {
            throw baselineChanged("captureScopes paths");
          }
          const afterScopeStates = await store.captureDirectory(sourceRoot, afterScopePaths, {
            signal: preparationSignal,
            ...(beforeInventory?.kind === "git" ? { indexModes: beforeInventory.indexModes } : {}),
            store: false,
          });
          const changedScopePaths = afterScopePaths.filter((file) => !sameState(
            baseline[file] ?? { kind: "missing" },
            afterScopeStates[file] ?? { kind: "missing" },
          ));
          if (changedScopePaths.length > 0) throw baselineChanged("captureScopes content or metadata");
        }
        await assertNoActiveBaselineWriters();
        if (typeof options.completeBaselineCapture === "function" && baselineCapture !== undefined) {
          const completed = await options.completeBaselineCapture(baselineCapture);
          baselineCapture = undefined;
          if (!completed.stable) {
            throw baselineChanged(`documents capture ${completed.reasons.join(",") || "unstable"}`);
          }
        }
        await createFromStates(store, baseline, baseRef);
      }, "exclusive", { executionWorkspace: captureWorkspaceId });
      const setupPending = existing.manifest.tools.includes("bash")
        && Boolean(options.worktrees.runSetup)
        && Boolean(effectiveSettings?.setup);
      worktree.preparationStage = setupPending ? "setup" : "ready";
      delete worktree.retentionReason;
      await options.registry.setWorkingState(input.scopeId, input.threadId, { branchId, worktree });
    } catch (error) {
      const latest = typeof options.registry.getThreadById === "function"
        ? await options.registry.getThreadById(input.scopeId, input.threadId)
        : await options.registry.getThread(input.scopeId, input.parent, input.threadId);
      const bound = latest?.workBranchId === branchId;
      if (!bound && options.workingStates) {
        await options.workingStates.withBranchStore(
          input.scopeId,
          "thread-baseline-capture-failed",
          (store) => store.deleteBranch(branchId),
        ).catch(() => undefined);
      }
      if (!bound && worktree.path) {
        try {
          await ownershipAssertion(worktree)("clean failed worktree preparation", [
            ...(worktree.materializationSwitch
              ? [worktree.materializationSwitch.stagingPath, worktree.materializationSwitch.backupPath]
              : []),
          ]);
          await fs.promises.rm(worktree.path, { recursive: true, force: true });
          const switchJournal = worktree.materializationSwitch;
          if (switchJournal?.stagingPath) {
            await fs.promises.rm(switchJournal.stagingPath, { recursive: true, force: true });
          }
          if (switchJournal?.backupPath) {
            await fs.promises.rm(switchJournal.backupPath, { recursive: true, force: true });
          }
          await removeOrphanMaterializationDirs(worktree, ownershipAssertion(worktree));
        } catch {
          // Refusal and cleanup failures leave the persisted path for explicit recovery.
        }
      }
      throw error;
    } finally {
      if (typeof options.completeBaselineCapture === "function" && baselineCapture !== undefined) {
        await options.completeBaselineCapture(baselineCapture).catch(() => undefined);
      }
      await dirtyBarrier?.release().catch(() => undefined);
    }
    return { branchId, worktree };
  };

  const prepareIsolatedBranch = async (input: PrepareIsolatedBranchInput): Promise<{ branchId: string; worktree: NonNullable<Thread["worktree"]> }> => (
    runPreparation(input.threadId, (signal, setStage) => {
      const merged = input.signal
        ? AbortSignal.any([signal, input.signal])
        : signal;
      return prepareIsolatedBranchCore({ ...input, signal: merged }, merged, setStage);
    })
  );

  const spawn = async (input: SpawnThreadRunInput): Promise<{ sessionId: string }> => {
    if (!await options.registry.canExecuteScope(input.scopeId)) throw new ThreadRuntimeError("unavailable", "Bot is asleep");
    const thread = await options.registry.getThread(input.scopeId, input.parent, input.threadId);
    const run = await options.registry.getActiveRun(input.scopeId, input.threadId);
    if (!thread || run?.id !== input.runId || !run.frozen) {
      throw new ThreadRuntimeError("unavailable", "Thread launch has no current frozen Run authority");
    }
    if (thread.worktree?.baselineUpdate) throw new ThreadRuntimeError("unavailable", `Finish baseline update ${thread.worktree.baselineUpdate.operationId} before starting execution`);
    const frozen = run.frozen;
    // Callers supply identity and any prepared prompt, never a second execution
    // configuration. Dequeue/recovery and direct dispatch use this same snapshot.
    const {
      model: _model,
      modelSettings: _modelSettings,
      permissions: _permissions,
      scope: _scope,
      systemPromptFragment: _fragment,
      workFocus: _workFocus,
      ...identity
    } = input;
    input = { ...identity, tools: [...frozen.tools], scope: [...frozen.scope], worktree: frozen.worktree,
      ...(frozen.modelSettings ? { modelSettings: { ...frozen.modelSettings } } : {}),
      ...(frozen.model ? { model: frozen.model } : {}),
      permissions: normalizeFrozenHarnessPermissions(frozen.permissions),
      workFocus: frozen.workFocus,
      ...(frozen.systemPromptFragment ? { systemPromptFragment: frozen.systemPromptFragment } : {}),
      ...(run.request?.preparedInput ? { promptText: run.request.preparedInput } : {}),
    };
    let releaseSpaceReservation = async (): Promise<void> => undefined;
    try {
      return await runPreparation(
        input.threadId,
        async (preparationSignal, setPreparationStage) => {
    const checkPreparation = (): void => {
      if (preparationSignal.aborted) throw new DOMException("Thread preparation aborted", "AbortError");
    };
    setPreparationStage("resolving-parent");
    const parent = await parentSession(input.scopeId, input.parent);
    let parentBlocks: Array<{ label: string; content: string }> | null | undefined;
    if (input.carryBlocks !== false && !input.inheritedContext && frozen.inputOrigin !== "fresh" && options.readBlocks) {
      try {
        parentBlocks = await options.readBlocks(parent.id);
      } catch (error) {
        parentBlocks = null;
        reportError(error);
      }
    }
    const existing = await options.registry.getThread(input.scopeId, input.parent, input.threadId);
    const sourceRoot = input.kind === "discussion" || isSessionScopeId(input.scopeId)
      ? parent.cwd
      : await options.resolveWorkspaceRoot(input.scopeId);
    const effectiveSettings = await resolveEffectiveWorktreeSettings(input.scopeId, input.parent);
    const draftBaselineId = existing?.manifest.draftBaselineId ?? input.draftBaselineId ?? null;
    if (existing && (input.draftBaselineId ?? null) !== existing.manifest.draftBaselineId) {
      throw new ThreadRuntimeError("invalid-request", "Thread draft baseline does not match its immutable launch manifest");
    }
    const sourceViewId = existing?.manifest.sourceViewId ?? input.sourceViewId ?? null;
    if (existing && (input.sourceViewId ?? null) !== (existing.manifest.sourceViewId ?? null)) {
      throw new ThreadRuntimeError("invalid-request", "Thread source view does not match its immutable launch manifest");
    }
    if (draftBaselineId && input.worktree !== "isolated") {
      throw new ThreadRuntimeError("invalid-request", "Threads with editor drafts require an isolated worktree");
    }
    let preparedCwd: string;
    let worktree = existing?.worktree;
    let needsBranchCapture = false;
    const retrievalParentInput = input.preset === "retrieval"
      && input.parent.kind === "thread"
      && input.worktree === "none"
      && Boolean(options.workingStates);
    const effectiveWorktreeMode = retrievalParentInput ? "isolated" as const : input.worktree;
    const physicalCloneOfParent = input.parent.kind === "session";
    if (physicalCloneOfParent && effectiveWorktreeMode === "isolated" && existing?.manifest.initialAuthorityRoot) {
      const frozenRoot = existing.manifest.initialAuthorityRoot;
      let sameSource = false;
      try {
        sameSource = sameDirectory(await fs.promises.realpath(frozenRoot), await fs.promises.realpath(sourceRoot));
      } catch {
        throw new ThreadRuntimeError("unavailable", "Frozen parent authority root is missing or inaccessible");
      }
      if (!sameSource) {
        throw new ThreadRuntimeError("unavailable", "Parent authority root cannot be mapped from the child clone source");
      }
    }
    const virtualIsolated = effectiveWorktreeMode === "isolated"
      && (!worktree || isVirtualWorktree(worktree));
    const mayMaterialize = runNeedsMaterializedDirectory(input.tools);
    if (!worktree) {
      if (effectiveWorktreeMode === "isolated" && mayMaterialize && effectiveSettings?.budget) {
        const reservation = await reserveMaterialization(
          input.scopeId,
          input.parent,
          input.threadId,
          effectiveSettings,
          await estimateResultFootprint(input.scopeId, null, null, sourceRoot),
        );
        releaseSpaceReservation = reservation.release;
        checkPreparation();
        if (reservation.failure) throw new ThreadRuntimeError("unavailable", `Worktree budget unavailable: ${reservation.failure}`);
      }
      setPreparationStage("preparing-worktree");
      let prep: Awaited<ReturnType<ThreadRuntimeOptions["worktrees"]["prepare"]>>;
      try {
        prep = await options.worktrees.prepare({
          mode: effectiveWorktreeMode,
          ...(virtualIsolated ? { viewMode: "virtual" as const } : {}),
          sourceRoot,
          threadId: input.threadId,
          signal: preparationSignal,
          onWorktreeState: async (candidate) => {
            worktree = candidate;
            if (candidate.preparationStage === "ready"
              && input.tools.includes("bash")
              && options.worktrees.runSetup
              && effectiveSettings?.setup) {
              candidate.preparationStage = "setup";
            }
            await options.registry.setWorktree(input.scopeId, input.threadId, candidate);
          },
        });
      } catch (error) {
        if (worktree && preparationStageOf(worktree) === "materializing") {
          await recordIncompleteMaterialization(
            input.scopeId,
            input.threadId,
            worktree,
            `Directory preparation did not complete: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        throw error;
      }
      preparedCwd = prep.cwd;
      worktree = prep.worktree;
      if (worktree) {
        if (virtualIsolated) {
          worktree.viewMode = "virtual";
          worktree.materialized = false;
          worktree.preparationStage = input.tools.includes("bash") && options.worktrees.runSetup && effectiveSettings?.setup
            ? "setup"
            : "ready";
        } else {
          worktree.viewMode = worktree.viewMode ?? "materialized";
          worktree.materialized = true;
          worktree.preparationStage = input.tools.includes("bash") && options.worktrees.runSetup && effectiveSettings?.setup
            ? "setup"
            : "ready";
        }
        delete worktree.materializationFingerprint;
        await options.registry.setWorktree(input.scopeId, input.threadId, worktree);
        needsBranchCapture = true;
      }
      // Persist the physical owner before observing cancellation: an
      // uninterruptible copy may have completed a directory by this point.
      checkPreparation();
    } else {
      const needsExistingMaterialization = !isVirtualWorktree(worktree) && (
        worktree.materialized === false
        || preparationStageOf(worktree) === "materialize"
        || preparationStageOf(worktree) === "materializing"
      );
      if (needsExistingMaterialization
        && !options.worktrees.materialize
        && !(options.workingStates && existing?.workBranchId && existing.resultRevision)) {
        throw new ThreadRuntimeError("unavailable", "Thread worktree materialization is unavailable");
      }
      if (needsExistingMaterialization && (
        Boolean(options.worktrees.materialize)
        || Boolean(options.workingStates && existing?.workBranchId && existing.resultRevision)
      )) {
        setPreparationStage("materializing-worktree");
        const reservation = await reserveMaterialization(
          input.scopeId,
          input.parent,
          input.threadId,
          effectiveSettings,
          await estimateResultFootprint(input.scopeId, existing ?? null, worktree, sourceRoot),
        );
        releaseSpaceReservation = reservation.release;
        checkPreparation();
        if (reservation.failure) throw new ThreadRuntimeError("unavailable", `Worktree budget unavailable: ${reservation.failure}`);
        worktree = await materializeRecordedWorktree({
          scopeId: input.scopeId,
          threadId: input.threadId,
          sourceRoot,
          worktree,
          ...(existing?.workBranchId ? { branchId: existing.workBranchId } : {}),
          ...(existing?.resultRevision ? { resultRevision: existing.resultRevision } : {}),
          setupRequired: Boolean(input.tools.includes("bash") && options.worktrees.runSetup && effectiveSettings?.setup),
          signal: preparationSignal,
        });
        checkPreparation();
      }
      preparedCwd = worktree.path;
      if (options.workingStates && !existing?.workBranchId) {
        needsBranchCapture = true;
      }
    }

    if (draftBaselineId && !worktree) {
      throw new ThreadRuntimeError("unavailable", "An isolated worktree was not created for the editor draft baseline");
    }
    if (draftBaselineId && needsBranchCapture && !options.workingStates) {
      throw new ThreadRuntimeError("unavailable", "Persistent working state is unavailable for the editor draft baseline");
    }

    // A persisted branch owns its capture scope. A missing worktree still
    // follows the existing branch capture/materialization flow, but must not
    // recopy live parent inputs or replace that scope from current settings.
    const launchBranchCapture = Boolean(worktree && needsBranchCapture && !existing?.workBranchId);
    if (launchBranchCapture && !virtualIsolated && options.worktrees.prepareInputs && effectiveSettings?.copyIgnored?.length) {
      setPreparationStage("preparing-inputs");
      await options.worktrees.prepareInputs(sourceRoot, worktree!, effectiveSettings, preparationSignal);
      checkPreparation();
    }
    if (worktree && needsBranchCapture && !existing?.workBranchId && options.workingStates) {
      const prepared = await prepareIsolatedBranchCore({
        scopeId: input.scopeId,
        parent: input.parent,
        threadId: input.threadId,
        draftBaselineId,
        signal: preparationSignal,
      }, preparationSignal, setPreparationStage);
      worktree = prepared.worktree;
      preparedCwd = worktree.path;
      checkPreparation();
    }
    if (worktree && !virtualIsolated && input.tools.includes("bash") && options.worktrees.runSetup && effectiveSettings?.setup) {
      setPreparationStage("running-setup");
      worktree.preparationStage = "setup";
      await options.registry.setWorktree(input.scopeId, input.threadId, worktree);
      try {
        await options.worktrees.runSetup(sourceRoot, worktree, effectiveSettings, preparationSignal);
        worktree.preparationStage = "ready";
        delete worktree.retentionReason;
        await options.registry.setWorktree(input.scopeId, input.threadId, worktree);
      } catch (setupErr) {
        const setupMessage = setupErr instanceof Error ? setupErr.message : String(setupErr);
        worktree.preparationStage = "setup";
        if (preparationSignal.aborted) {
          worktree.retentionReason = "Directory setup was interrupted";
          await options.registry.setWorktree(input.scopeId, input.threadId, worktree).catch(reportError);
          throw setupErr;
        }
        const setupFailure = setupErr as { exitReason?: unknown } | null;
        const exitReason = typeof setupFailure?.exitReason === "string" ? setupFailure.exitReason : "setup-failed";
        const message = setupMessage;
        worktree.retentionReason = `Directory setup failed: ${message}`;
        await options.registry.setWorktree(input.scopeId, input.threadId, worktree).catch(reportError);
        await options.registry.endRun(
          input.scopeId,
          input.threadId,
          input.runId,
          "failure",
          exitReason,
          {
            conclusion: `Worktree setup failed: ${message}`,
            changedFiles: [],
            unresolved: ["Setup command failed"],
            deviations: [],
            confidence: 0,
            transcriptRef: {
              runtimeId: "pi",
              sessionId: "",
              fromEntryId: null,
              toEntryId: null,
            },
            blocksSnapshot: {},
          },
        );
        throw new ThreadRuntimeError("unavailable", `Worktree setup failed: ${message}`);
      }
    }

    if (effectiveSettings?.budget) {
      const actualFailure = await withSpaceMutation(input.scopeId, () => budgetFailureFor(
        input.scopeId,
        input.parent,
        effectiveSettings,
        { logicalBytes: 0, allocatedBytes: 0, unknown: false },
        input.threadId,
      ));
      if (actualFailure) throw new ThreadRuntimeError("unavailable", `Worktree budget unavailable: ${actualFailure}`);
    }

    checkPreparation();
    setPreparationStage("opening-session");
    const runtimeWorkspaceId = await options.resolveRuntimeWorkspaceId(preparedCwd);
    const childAuthorityRoot = await options.resolveWorkspaceRoot(runtimeWorkspaceId);
    if (existing?.manifest.initialAuthorityRoot) {
      await assertChildAuthorityRoot(existing.manifest.initialAuthorityRoot, {
        authorityRoot: childAuthorityRoot,
        sessionRoot: preparedCwd,
        worktree,
      });
    }
    let sessionId: string | null = null;
    try {
      const snapshot = await options.sessions.create({
        cwd: preparedCwd,
        name: `${input.preset ?? "Thread"}: ${input.brief.slice(0, 80)}`,
        parentSession: parent.file,
        modelSettings: frozen.modelSettings ?? null,
        ...(input.model ? { model: input.model } : {}),
        permissions: normalizeFrozenHarnessPermissions(input.permissions),
        ...(input.scope?.length ? { scope: [...input.scope] } : {}),
        tools: [...input.tools],
        workFocus: frozen.workFocus,
        workspaceId: runtimeWorkspaceId,
      });
      sessionId = snapshot.sessionId;
      const binding = {
        scopeId: input.scopeId,
        parent: input.parent,
        threadId: input.threadId,
        runId: input.runId,
        sessionId,
        cwd: preparedCwd,
        kind: input.kind,
        providerId: input.model?.providerId ?? null,
        baseline: { cost: 0, toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0 } },
      };
      bind(binding);
      await bindExecutionView({
        sessionId,
        scopeId: input.scopeId,
        parent: input.parent,
        threadId: input.threadId,
        runId: input.runId,
      });
      checkPreparation();
      scheduleStallTimer(binding);
      await options.registry.markRunRunning(input.scopeId, input.threadId, input.runId, sessionId);
      options.onThreadSessionBound?.(sessionId, input.scopeId);
      checkPreparation();
      checkPreparation();
      // Messages held while the Thread was queued flush into the first Run's
      // input here — they never start execution on their own (3.18C).
      const heldMessages = await options.registry.listPendingThreadMessages(input.scopeId, input.threadId, run.request?.requestId);
      const basePrompt = input.kind === "discussion" ? discussionPrompt(input, parentBlocks) : initialPrompt(input, parentBlocks);
      const sourceContext = sourceViewId ? await options.sourceViews?.contextFor(sourceViewId) : undefined;
      if (sourceViewId && !sourceContext) throw new ThreadRuntimeError("unavailable", "The fixed thread source view is unavailable");
      await options.sessions.prompt(
        sessionId,
        heldMessages.length > 0
          ? `${basePrompt}\n\nMessages delivered while this thread was queued:\n${pendingMessagesSection(heldMessages)}`
          : basePrompt,
        undefined,
        input.inheritedContext?.images,
        sourceContext ?? undefined,
      );
      await options.registry.acknowledgeThreadMessages(input.scopeId, input.threadId, heldMessages.map((message) => message.id), input.runId);
      checkPreparation();
      if (virtualIsolated && mayMaterialize && effectiveSettings?.budget) {
        pendingMaterializeReservations.set(input.threadId, releaseSpaceReservation);
        releaseSpaceReservation = async () => undefined;
      }
      return { sessionId };
    } catch (error) {
      if (sessionId) {
        if (!preparationSignal.aborted) {
          await options.registry.endRun(
            input.scopeId,
            input.threadId,
            input.runId,
            "failure",
            `start failed: ${error instanceof Error ? error.message : String(error)}`,
          ).catch(reportError);
          const binding = bindingsBySession.get(sessionId);
          if (binding) await closeBinding(binding, false);
        }
      }
      throw error;
    }
        },
      );
    } catch (error) {
      const isAbort = error instanceof DOMException && error.name === "AbortError";
      if (!isAbort) {
        const active = await options.registry.getActiveRun(input.scopeId, input.threadId).catch(() => null);
        if (active?.id === input.runId && active.outcome === null) {
          await options.registry.endRun(
            input.scopeId,
            input.threadId,
            input.runId,
            "failure",
            `thread preparation failed: ${error instanceof Error ? error.message : String(error)}`,
          ).catch(reportError);
        }
      }
      throw error;
    } finally {
      await releaseSpaceReservation();
    }
  };

  const updateRunMetrics = async (binding: RuntimeBinding): Promise<void> => {
    const stats = await options.sessions.stats(binding.sessionId);
    await options.registry.updateRunProgress(binding.scopeId, binding.threadId, {
      steps: Math.max(0, stats.toolCalls - binding.baseline.toolCalls),
      tokens: {
        input: Math.max(0, stats.tokens.input - binding.baseline.tokens.input),
        output: Math.max(0, stats.tokens.output - binding.baseline.tokens.output),
        cacheRead: Math.max(0, stats.tokens.cacheRead - binding.baseline.tokens.cacheRead),
      },
      costUsd: Math.max(0, stats.cost - binding.baseline.cost),
    });
  };

  const createDiscussion = async (input: {
    carryBlocks?: boolean;
    entryId: string;
    parentSessionId: string;
  }): Promise<ThreadMutationSnapshot> => {
    const scope = await scopeForSession(input.parentSessionId);
    if (!scope.snapshot) {
      throw new ThreadRuntimeError("unavailable", "Open the parent Pi session before creating a discussion thread");
    }
    const parentEntries = await options.sessions.entries(input.parentSessionId, "branch");
    const selected = parentEntries.entries.find((entry) => entry.id === input.entryId);
    if (!selected) {
      throw new ThreadRuntimeError("conflict", "The selected message is no longer on the active conversation branch");
    }
    if (selected.type !== "message" || (selected.message.role !== "user" && selected.message.role !== "assistant")) {
      throw new ThreadRuntimeError("invalid-request", "A discussion thread can only start from a user or assistant message");
    }
    const brief = entryText(selected);
    if (!brief) throw new ThreadRuntimeError("invalid-request", "The selected message has no text to discuss");
    const tools = scope.snapshot.activeTools.filter((tool) => DISCUSSION_TOOLS.has(tool));
    const model = scope.snapshot.model
      ? { providerId: scope.snapshot.model.provider, modelId: scope.snapshot.model.id }
      : undefined;
    const createInput: CreateThreadInput = {
      scopeId: scope.scopeId,
      parent: scope.parent,
      brief,
      kind: "discussion",
      createdBy: "user",
      forkPoint: { entryId: input.entryId },
      carryBlocks: input.carryBlocks ?? true,
      concurrency: options.registry.maxConcurrency,
      worktree: "none",
      ...(model ? { model } : {}),
      tools,
      permissions: normalizeFrozenHarnessPermissions({}),
      autoRun: true,
    };
    const thread = await options.registry.createThread(createInput);
    const run = await options.registry.startRun(scope.scopeId, thread.id);
    try {
      await spawn({ ...createInput, threadId: thread.id, runId: run.id });
    } catch (error) {
      await options.registry.endRun(
        scope.scopeId,
        thread.id,
        run.id,
        "failure",
        `discussion start failed: ${error instanceof Error ? error.message : String(error)}`,
      ).catch(reportError);
      throw error;
    }
    const [current, activeRun] = await Promise.all([
      options.registry.getThread(scope.scopeId, scope.parent, thread.id),
      options.registry.getActiveRun(scope.scopeId, thread.id),
    ]);
    if (!current || !activeRun) throw new Error(`Discussion thread disappeared after creation: ${thread.id}`);
    return { scopeId: scope.scopeId, parent: scope.parent, thread: current, activeRun };
  };

  const settleDiscussionTurn = async (binding: RuntimeBinding): Promise<void> => {
    clearStallTimer(binding.sessionId);
    lastAgentEnd.delete(binding.sessionId);
    try {
      await updateRunMetrics(binding);
    } catch (error) {
      reportError(error);
    }
    const thread = await options.registry.getThread(binding.scopeId, binding.parent, binding.threadId);
    if (thread?.lifecycle === "active" && thread.attention === "none") {
      waitingSessions.add(binding.sessionId);
      await options.registry.setAttention(
        binding.scopeId,
        binding.threadId,
        "user",
        { kind: "user", text: "Ready for the next discussion message" },
      );
    }
  };

  const projectVerification = async (
    workspaceId: string,
    threadId: string,
    currentResultRevision: number | undefined,
    write: (store: WorkingStateRootStore) => Promise<import("@varin/protocol").ThreadVerificationProjection>,
  ): Promise<void> => {
    if (!options.workingStates) return;
    const projection = await options.workingStates.withBranchStore(workspaceId, "thread-verification", write);
    await options.registry.setVerification(workspaceId, threadId, projection);
  };


  const settle = async (binding: RuntimeBinding): Promise<void> => {
    const currentRun = await options.registry.getActiveRun(binding.scopeId, binding.threadId);
    if (!currentRun || currentRun.id !== binding.runId || currentRun.outcome !== null) return;
    const end = lastAgentEnd.get(binding.sessionId) ?? { messages: [], willRetry: false };
    if (end.willRetry) return;
    const thread = await options.registry.getThread(binding.scopeId, binding.parent, binding.threadId);
    if (!thread) return;
    if (thread.worktree?.baselineUpdate) {
      await options.registry.setAttention(binding.scopeId, binding.threadId, "stalled");
      throw new ThreadRuntimeError("unavailable", `Finish baseline update ${thread.worktree.baselineUpdate.operationId} before settling execution`);
    }
    const conclusion = assistantConclusion(end.messages);
    const [statsResult, entriesResult, blocksResult] = await Promise.all([
      options.sessions.stats(binding.sessionId).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      options.sessions.entries(binding.sessionId).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      options.readBlocks
        ? options.readBlocks(binding.sessionId).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          )
        : Promise.resolve({ ok: true as const, value: undefined }),
    ]);
    let changedFiles: string[] = [];
    let diffStats = thread.diffStats;
    const unresolved: string[] = conclusion.error ? [conclusion.error] : [];
    const stats = statsResult.ok ? statsResult.value : null;
    const entries = entriesResult.ok ? entriesResult.value : null;
    const blocks = blocksResult.ok ? blocksResult.value : undefined;
    const runs = await options.registry.listRuns(binding.scopeId, binding.threadId);
    const transcriptBounds = transcriptRefForRun(entries?.entries ?? [], currentRun, runs, binding.sessionId);
    if (!statsResult.ok) {
      unresolved.push(`Unable to read run metrics: ${statsResult.error instanceof Error ? statsResult.error.message : String(statsResult.error)}`);
    }
    if (!entriesResult.ok) {
      unresolved.push(`Unable to read durable transcript bounds: ${entriesResult.error instanceof Error ? entriesResult.error.message : String(entriesResult.error)}`);
    }
    if (!blocksResult.ok) {
      unresolved.push(`Unable to read thread blocks: ${blocksResult.error instanceof Error ? blocksResult.error.message : String(blocksResult.error)}`);
    } else if (blocks === null) {
      unresolved.push("Thread block storage was unavailable at settlement");
    }
    if (thread.preset === "retrieval") {
      if (stats) {
        await options.registry.updateRunProgress(binding.scopeId, binding.threadId, {
          steps: Math.max(0, stats.toolCalls - binding.baseline.toolCalls),
          tokens: {
            input: Math.max(0, stats.tokens.input - binding.baseline.tokens.input),
            output: Math.max(0, stats.tokens.output - binding.baseline.tokens.output),
            cacheRead: Math.max(0, stats.tokens.cacheRead - binding.baseline.tokens.cacheRead),
          },
          costUsd: Math.max(0, stats.cost - binding.baseline.cost),
        });
      }
      const report: ThreadReport = {
        conclusion: conclusion.text,
        changedFiles: [],
        unresolved: [...new Set(unresolved)],
        deviations: [],
        confidence: conclusion.error ? 0 : 0.5,
        transcriptRef: {
          runtimeId: "pi",
          sessionId: binding.sessionId,
          ...transcriptBounds,
        },
        blocksSnapshot: Object.fromEntries((blocks ?? []).map((block) => [block.label, block.content])),
      };
      await options.registry.endRun(
        binding.scopeId,
        binding.threadId,
        binding.runId,
        conclusion.error ? "failure" : "success",
        conclusion.error,
        report,
      );
      await closeBinding(binding, false);
      const settled = await options.registry.getThreadById(binding.scopeId, binding.threadId);
      if (settled?.worktree && options.worktrees.discardInput) {
        await options.worktrees.discardInput(settled.worktree, binding.scopeId).catch(reportError);
        await options.registry.setWorktree(binding.scopeId, binding.threadId, settled.worktree).catch(reportError);
      }
      await releasePendingMaterializeReservation(binding.threadId);
      return;
    }
    let currentWorktree = thread.worktree;
    let publishedResultRevision: number | undefined;
    let nativeResultUnavailable = Boolean(thread.workBranchId && (!options.workingStates || !currentWorktree));
    if (currentWorktree) {
      let inspected: Awaited<ReturnType<ThreadWorktreeRuntime["inspect"]>> | null = null;
      let fixedSnapshotReady = false;
      const inspectVirtualWithoutBranch = isVirtualWorktree(currentWorktree)
        && (!options.workingStates || !thread.workBranchId);
      const nativeMaterializedResult = Boolean(options.workingStates && thread.workBranchId && !isVirtualWorktree(currentWorktree));
      if (nativeMaterializedResult && currentWorktree.base !== "zero-commit") {
        try {
          inspected = await options.worktrees.inspect(currentWorktree, "live");
          changedFiles = inspected.changedFiles;
          diffStats = inspected.diffStats;
        } catch (error) {
          nativeResultUnavailable = true;
          unresolved.push(`Unable to inspect Git execution result: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (!isVirtualWorktree(currentWorktree) && !nativeMaterializedResult) {
        try {
          currentWorktree = await options.worktrees.snapshot(currentWorktree);
          if (!currentWorktree.resultPath && options.worktrees.verifyFixedResult
            && !await options.worktrees.verifyFixedResult(currentWorktree)) {
            throw new Error("Thread result changed after its fixed snapshot was created");
          }
          fixedSnapshotReady = true;
        } catch (error) {
          nativeResultUnavailable = Boolean(thread.workBranchId);
          unresolved.push(`Unable to snapshot thread result: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (fixedSnapshotReady || inspectVirtualWithoutBranch) {
        try {
          inspected = await options.worktrees.inspect(currentWorktree, fixedSnapshotReady ? "fixed" : "live");
          changedFiles = inspected.changedFiles;
          diffStats = inspected.diffStats;
        } catch (error) {
          unresolved.push(`Unable to inspect worktree: ${error instanceof Error ? error.message : String(error)}`);
          if (thread.workBranchId) nativeResultUnavailable = true;
        }
      }
      if (options.workingStates && thread.workBranchId && !nativeResultUnavailable) {
        try {
          const publishedIndexModes = !isVirtualWorktree(currentWorktree)
            ? await options.worktrees.inspectIndexModes?.(currentWorktree!.path)
            : undefined;
          const published = await options.workingStates.withBranchStore(
            binding.scopeId,
            "thread-result-publish",
            async (store) => {
              if (isVirtualWorktree(currentWorktree)) return store.publishHeadResult(thread.workBranchId!);
              const paths = await materializedPublishPaths(
                store,
                thread.workBranchId!,
                currentWorktree!.path,
                currentWorktree!.base === "zero-commit" ? undefined : inspected!.changedFiles,
              );
              return store.publishDirectoryResult(
                thread.workBranchId!,
                currentWorktree!.path,
                paths,
                publishedIndexModes === undefined ? {} : { indexModes: publishedIndexModes },
              );
            },
            "exclusive",
            isVirtualWorktree(currentWorktree) ? undefined
              : { executionWorkspace: await options.resolveRuntimeWorkspaceId(currentWorktree!.path) },
          );
          publishedResultRevision = published.resultRevision;
          changedFiles = published.changedPaths;
          diffStats = published.diffStats;
          if (options.verification) {
            try {
              const projection = await options.workingStates.withBranchStore(
                binding.scopeId,
                "thread-result-verify",
                (store) => options.verification!.bindPublishedResult(store, {
                  workspaceId: binding.scopeId,
                  threadId: binding.threadId,
                  runId: binding.runId,
                  branchId: thread.workBranchId!,
                  resultRevision: published.resultRevision,
                  worktreePath: currentWorktree!.path,
                }),
              );
              await options.registry.setVerification(binding.scopeId, binding.threadId, projection);
            } catch (error) {
              unresolved.push(`Unable to bind result verification: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          await options.registry.setWorkingState(binding.scopeId, binding.threadId, {
            branchId: thread.workBranchId,
            resultRevision: published.resultRevision,
            worktree: currentWorktree,
            diffStats: published.diffStats,
          });
          const previewCoordinator = options.resolveIntegrationCoordinator
            ? await options.resolveIntegrationCoordinator(binding.scopeId)
            : null;
          if (previewCoordinator) {
            try {
              const preview = await previewCoordinator.previewResult({
                workspaceId: binding.scopeId,
                threadId: binding.threadId,
                branchId: thread.workBranchId,
                resultRevision: published.resultRevision,
              });
              await options.registry.setIntegration(
                binding.scopeId,
                binding.threadId,
                preview.mergeReady ? "merge-ready" : preview.conflictPaths.length > 0 || preview.unavailablePaths.length > 0
                  ? "conflict"
                  : "dirty",
                published.diffStats,
              );
              await options.registry.setIntegrationBinding(
                binding.scopeId,
                binding.threadId,
                threadIntegrationBindingFromPreview(preview),
              );
            } catch (error) {
              unresolved.push(`Unable to bind integration preview: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        } catch (error) {
          nativeResultUnavailable = true;
          unresolved.push(`Unable to publish native thread result: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (nativeResultUnavailable && thread.workBranchId) {
        // The branch pointer is the default merge authority. Clear its current
        // result before attempting the independent Git snapshot, otherwise an
        // inspect/publish failure can make the next merge consume an older Run.
        await options.registry.setWorkingState(binding.scopeId, binding.threadId, {
          branchId: thread.workBranchId,
          resultRevision: null,
          worktree: currentWorktree,
          ...(diffStats ? { diffStats } : {}),
        });
      }
      if (fixedSnapshotReady) {
        try {
        if (thread.workBranchId) {
          await options.registry.setWorkingState(binding.scopeId, binding.threadId, {
            branchId: thread.workBranchId,
            ...(nativeResultUnavailable
              ? { resultRevision: null }
              : publishedResultRevision ? { resultRevision: publishedResultRevision } : {}),
            worktree: currentWorktree,
            ...(diffStats ? { diffStats } : {}),
          });
        } else {
          await options.registry.setWorktree(binding.scopeId, binding.threadId, currentWorktree);
        }
        } catch (error) {
          unresolved.push(`Unable to persist fixed thread result: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (nativeResultUnavailable) {
        await options.registry.setIntegration(
          binding.scopeId,
          binding.threadId,
          "conflict",
          diffStats,
        ).catch(reportError);
      } else if (publishedResultRevision === undefined && inspected) {
        await options.registry.setIntegration(
          binding.scopeId,
          binding.threadId,
          changedFiles.length > 0 ? "dirty" : "none",
          diffStats,
        );
      }
      if (options.measureManagedDirectory || options.worktrees.measureDiskUsage) {
        try {
          if (options.measureManagedDirectory) {
            const measured = await options.measureManagedDirectory(binding.scopeId, currentWorktree);
            if (measured.logicalBytes === null) delete currentWorktree.diskBytes;
            else currentWorktree.diskBytes = measured.logicalBytes;
          } else {
            await options.worktrees.measureDiskUsage!(currentWorktree);
          }
          await options.registry.setWorktree(binding.scopeId, binding.threadId, currentWorktree);
        } catch (error) {
          unresolved.push(`Unable to measure worktree disk usage: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (!currentWorktree && nativeResultUnavailable && thread.workBranchId) {
      await options.registry.setWorkingState(binding.scopeId, binding.threadId, {
        branchId: thread.workBranchId,
        resultRevision: null,
        ...(diffStats ? { diffStats } : {}),
      });
      await options.registry.setIntegration(binding.scopeId, binding.threadId, "conflict", diffStats).catch(reportError);
    }
    if (stats) {
      await options.registry.updateRunProgress(binding.scopeId, binding.threadId, {
        steps: Math.max(0, stats.toolCalls - binding.baseline.toolCalls),
        tokens: {
          input: Math.max(0, stats.tokens.input - binding.baseline.tokens.input),
          output: Math.max(0, stats.tokens.output - binding.baseline.tokens.output),
          cacheRead: Math.max(0, stats.tokens.cacheRead - binding.baseline.tokens.cacheRead),
        },
        costUsd: Math.max(0, stats.cost - binding.baseline.cost),
        ...(diffStats ? { diffStats } : {}),
      });
    }
    const blocksSnapshot = Object.fromEntries((blocks ?? []).map((block) => [block.label, block.content]));
    const report: ThreadReport = {
      conclusion: conclusion.text,
      changedFiles,
      unresolved,
      deviations: [],
      confidence: conclusion.error ? 0 : 0.5,
      transcriptRef: {
        runtimeId: "pi",
        sessionId: binding.sessionId,
        ...transcriptBounds,
      },
      blocksSnapshot,
      ...(currentWorktree?.resultCommit ? { resultCommit: currentWorktree.resultCommit } : {}),
      ...(publishedResultRevision ? { resultRevision: publishedResultRevision } : {}),
    };
    const outcome: ThreadRunOutcome = conclusion.error ? "failure" : "success";
    await options.registry.endRun(
      binding.scopeId,
      binding.threadId,
      binding.runId,
      outcome,
      conclusion.error,
      report,
    );
    autoResumedThreads.delete(`${binding.scopeId}\0${binding.threadId}`);
    await closeBinding(binding, false);
    await releasePendingMaterializeReservation(binding.threadId);
  };

  const processEvent = (event: BrokerEventLike): void => {
    const sessionId = event.sessionId;
    if (!sessionId) return;
    const binding = bindingsBySession.get(sessionId);
    if (!binding) return;
    if (event.kind === "worker.exit") {
      // Only the bound session worker's exit loses the Run; an auxiliary
      // worker (e.g. the session's compaction worker) shares the sessionId.
      if (event.role !== "session") return;
      if (terminatingSessions.has(sessionId)) return;
      enqueue(binding.threadId, async () => {
        let shouldResume = false;
        await withThreadLifecycle(binding.scopeId, binding.threadId, async () => {
          const run = await options.registry.getActiveRun(binding.scopeId, binding.threadId);
          if (run?.id !== binding.runId || run.outcome !== null) return;
          const thread = await options.registry.getThread(binding.scopeId, binding.parent, binding.threadId);
          if (!thread?.worktree?.baselineUpdate) {
            await publishPartialResult(binding.scopeId, binding.parent, binding.threadId).catch(reportError);
          }
          await options.registry.endRun(
            binding.scopeId,
            binding.threadId,
            binding.runId,
            "lost",
            event.expected ? "worker closed before the Run settled" : "worker exited unexpectedly",
          );
          shouldResume = !event.expected;
        });
        bindingsBySession.delete(sessionId);
        if (sessionByThread.get(binding.threadId) === sessionId) sessionByThread.delete(binding.threadId);
        options.verification?.detachSession(sessionId);
        lastAgentEnd.delete(sessionId);
        clearStallTimer(sessionId);
        stalledThreads.delete(`${binding.scopeId}\0${binding.threadId}`);
        waitingSessions.delete(sessionId);
        if (shouldResume) {
            const key = `${binding.scopeId}\0${binding.threadId}`;
            if (!autoResumedThreads.has(key)) {
              autoResumedThreads.add(key);
              await resumeLostForParent(binding.scopeId, binding.parent);
            } else {
              await options.registry.setAttention(binding.scopeId, binding.threadId, "stalled");
            }
        }
      });
      return;
    }
    if (event.kind !== "host" || event.envelope?.kind !== "event") return;
    if (event.envelope.event === "extension.ui.dismiss") {
      clearWaitingAttention(binding);
      return;
    }
    if (event.envelope.event === "extension.ui.request") {
      const request = recordOf(event.envelope.data);
      const payload = recordOf(request.payload);
      if (
        typeof request.id === "string"
        && (request.method === "select" || request.method === "confirm" || request.method === "input" || request.method === "editor")
      ) {
        markAgentActivity(binding);
        const choices = Array.isArray(payload.options) ? payload.options : [];
        const permission = choices.includes("Allow once") && choices.includes("Deny");
        const text = typeof payload.title === "string" && payload.title.trim()
          ? payload.title.trim()
          : permission ? "Permission required" : "Input required";
        waitingSessions.add(sessionId);
        enqueue(binding.threadId, async () => {
          await options.registry.setAttention(
            binding.scopeId,
            binding.threadId,
            permission ? "permission" : "user",
            { kind: permission ? "permission" : "user", text },
          );
        });
      }
      return;
    }
    if (event.envelope.event !== "agent.event") return;
    const agentEvent = recordOf(recordOf(event.envelope.data).event);
    markAgentActivity(binding);
    clearWaitingAttention(binding);
    if (agentEvent.type === "agent_end") {
      lastAgentEnd.set(sessionId, {
        messages: Array.isArray(agentEvent.messages) ? agentEvent.messages as PiMessage[] : [],
        willRetry: agentEvent.willRetry === true,
      });
      return;
    }
    if (agentEvent.type === "tool_execution_start") {
      enqueue(binding.threadId, async () => {
        const [thread, run] = await Promise.all([
          options.registry.getThread(binding.scopeId, binding.parent, binding.threadId),
          options.registry.getActiveRun(binding.scopeId, binding.threadId),
        ]);
        if (!run || run.id !== binding.runId || run.outcome !== null) return;
        const key = `${binding.scopeId}\0${binding.threadId}`;
        const signatures = [...(recentToolSignatures.get(key) ?? []), toolSignature(agentEvent.toolName, agentEvent.args)]
          .slice(-LOOP_WINDOW);
        recentToolSignatures.set(key, signatures);
        await options.registry.updateRunProgress(binding.scopeId, binding.threadId, {
          steps: run.steps + 1,
          lastToolCall: {
            name: typeof agentEvent.toolName === "string" ? agentEvent.toolName : "unknown",
            at: new Date().toISOString(),
          },
        });
        const looping = signatures.length === LOOP_WINDOW && signatures.every((signature) => signature === signatures[0]);
        if (looping && thread?.attention === "none") {
          await options.registry.setAttention(binding.scopeId, binding.threadId, "looping");
        } else if (!looping && thread?.attention === "looping") {
          await options.registry.setAttention(binding.scopeId, binding.threadId, "none");
        }
      });
      return;
    }
    if (agentEvent.type === "agent_settled") {
      enqueue(
        binding.threadId,
        () => binding.kind === "discussion"
          ? settleDiscussionTurn(binding)
          : withThreadLifecycle(binding.scopeId, binding.threadId, () => settle(binding)).then(async () => {
              const run = await options.registry.getActiveRun(binding.scopeId, binding.threadId);
              if (run?.outcome === null) return;
              const effectiveSettings = await resolveEffectiveWorktreeSettings(binding.scopeId, binding.parent);
              if (effectiveSettings?.reclaimIdle) {
                await tryAutoReclaimDirectory(binding.scopeId, binding.parent, binding.threadId).catch(reportError);
              }
            }),
      );
    }
  };

  const resumeLostForParent = async (workspaceId: string, parent: ThreadParent): Promise<void> => {
    if (!await options.registry.canExecuteScope(workspaceId)) return;
    const threads = await options.registry.listThreads(workspaceId, parent, true);
    for (let thread of threads) {
      let previous = await options.registry.getActiveRun(workspaceId, thread.id);
      // Attached roots borrow user-owned sessions and resume only on the next
      // real prompt; spawned-child recovery must never open one. The same
      // applies to bot entry chats — reopening the entry re-attaches.
      if (isAttachedRootPurpose(thread.purpose) || previous?.sessionOwner === "attached-root") continue;
      if (thread.lifecycle !== "active" || previous?.outcome !== "lost") continue;
      if (resuming.has(thread.id)) continue;
      resuming.add(thread.id);
      const task = (async () => {
        try {
          // Host restart and worker-loss recovery are also the restart entry for
          // a persisted directory-apply/branch-CAS handoff. Reconcile it before
          // partial publication or Run admission can replace result identity.
          if (thread.worktree?.baselineUpdate) {
            const pending = thread.worktree.baselineUpdate;
            try {
              await updateBaseline(workspaceId, thread.parent, thread.id, pending.parentResultRevision);
            } catch (error) {
              await options.registry.setAttention(workspaceId, thread.id, "stalled").catch(reportError);
              reportError(error);
              return;
            }
            const recovered = await options.registry.getThread(workspaceId, thread.parent, thread.id);
            if (!recovered || recovered.worktree?.baselineUpdate) {
              await options.registry.setAttention(workspaceId, thread.id, "stalled").catch(reportError);
              return;
            }
            thread = recovered;
          }
          await withThreadLifecycle(workspaceId, thread.id, async () => {
          const latest = await options.registry.getThread(workspaceId, thread.parent, thread.id);
          const latestRun = await options.registry.getActiveRun(workspaceId, thread.id);
          if (!latest || latest.worktree?.baselineUpdate || latestRun?.outcome !== "lost") return;
          thread = latest;
          previous = latestRun;
          // Lost-run resume shares the root execution budget (3.18C): when the
          // pool is full the Thread stays lost until the next admission trigger.
          if (await options.registry.countActiveInRoot(workspaceId, thread.parent) >= thread.manifest.concurrency) return;
        await publishPartialResult(workspaceId, parent, thread.id);
        let run: ThreadRun;
        try {
          run = await options.registry.startRun(workspaceId, thread.id, previous.runtimeId);
        } catch (error) {
          if (error instanceof ThreadAdmissionError) return;
          throw error;
        }
        const frozen = run.frozen;
        if (!frozen) throw new ThreadRuntimeError("unavailable", "Recovered Run has no frozen execution configuration");
        let resumedSessionId: string | null = null;
        try {
          if (!previous.sessionId) {
            await spawn({
              scopeId: workspaceId,
              parent,
              threadId: thread.id,
              runId: run.id,
              brief: thread.brief,
              ...(thread.preset ? { preset: thread.preset } : {}),
              kind: thread.kind,
              createdBy: thread.createdBy,
              carryBlocks: thread.manifest.carryBlocks,
              concurrency: thread.manifest.concurrency,
              ...(thread.manifest.draftBaselineId ? { draftBaselineId: thread.manifest.draftBaselineId } : {}),
              ...(thread.manifest.sourceViewId ? { sourceViewId: thread.manifest.sourceViewId } : {}),
              ...(thread.manifest.inputOrigin !== undefined ? { inputOrigin: thread.manifest.inputOrigin } : {}),
              ...(thread.manifest.inheritedContext ? { inheritedContext: thread.manifest.inheritedContext } : {}),
              autoRun: true,
              worktree: frozen.worktree,
              ...(frozen.model ? { model: frozen.model } : {}),
              tools: [...frozen.tools],
              permissions: normalizeFrozenHarnessPermissions(frozen.permissions),
              ...(frozen.scope.length > 0 ? { scope: [...frozen.scope] } : {}),
              ...(frozen.systemPromptFragment
                ? { systemPromptFragment: frozen.systemPromptFragment }
                : {}),
            });
            return;
          }
          const sourceRoot = await options.resolveWorkspaceRoot(workspaceId);
          const cwd = thread.worktree?.path ?? sourceRoot;
          const runtimeWorkspaceId = await options.resolveRuntimeWorkspaceId(cwd);
          const snapshot = await options.sessions.open({
            modelSettings: frozen.modelSettings ?? null,
            cwd,
            ...(frozen.model ? { model: frozen.model } : {}),
            permissions: normalizeFrozenHarnessPermissions(frozen.permissions),
            ...(frozen.scope.length > 0 ? { scope: [...frozen.scope] } : {}),
            sessionId: previous.sessionId!,
            tools: [...frozen.tools],
            workFocus: frozen.workFocus,
            workspaceId: runtimeWorkspaceId,
          });
          resumedSessionId = snapshot.sessionId;
          const baselineStats = await options.sessions.stats(snapshot.sessionId).catch((error) => {
            reportError(error);
            return null;
          });
          const binding = {
            scopeId: workspaceId,
            parent,
            threadId: thread.id,
            runId: run.id,
            sessionId: snapshot.sessionId,
            cwd,
            kind: thread.kind,
            providerId: frozen.model?.providerId ?? null,
            baseline: {
              cost: baselineStats?.cost ?? 0,
              toolCalls: baselineStats?.toolCalls ?? 0,
              tokens: {
                input: baselineStats?.tokens.input ?? 0,
                output: baselineStats?.tokens.output ?? 0,
                cacheRead: baselineStats?.tokens.cacheRead ?? 0,
              },
            },
          };
          bind(binding);
          await bindExecutionView({
            sessionId: snapshot.sessionId,
            scopeId: workspaceId,
            parent,
            threadId: thread.id,
            runId: run.id,
          });
          if (thread.attention === "user" || thread.attention === "permission") {
            waitingSessions.add(snapshot.sessionId);
          }
          await options.registry.markRunRunning(workspaceId, thread.id, run.id, snapshot.sessionId);
          options.onThreadSessionBound?.(snapshot.sessionId, workspaceId);
          if (thread.kind === "implementation") {
            scheduleStallTimer(binding);
            await options.sessions.prompt(
              snapshot.sessionId,
              "The previous worker was interrupted. This Run resumes the retained session; an interrupted tool operation may have completed without a recorded response.",
            );
          }
        } catch (error) {
          await options.registry.endRun(
            workspaceId,
            thread.id,
            run.id,
            "failure",
            `resume failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          if (resumedSessionId) {
            const resumedBinding = bindingsBySession.get(resumedSessionId);
            if (resumedBinding) await closeBinding(resumedBinding, false).catch(reportError);
            else await options.sessions.close(resumedSessionId).catch(reportError);
          }
          reportError(error);
        }
          });
        } finally { resuming.delete(thread.id); }
      })();
      const tracked = task.catch(reportError);
      backgroundTasks.add(tracked);
      void tracked.then(() => backgroundTasks.delete(tracked));
    }
  };

  const convertDiscussion = async (input: {
    parentSessionId: string;
    threadId: string;
  }): Promise<ThreadMutationSnapshot> => {
    const scope = await scopeForSession(input.parentSessionId);
    return withThreadLifecycle(scope.scopeId, input.threadId, async () => {
      if (!scope.snapshot) {
        throw new ThreadRuntimeError("unavailable", "Open the parent Pi session before converting its discussion thread");
      }
      const thread = await options.registry.getThread(scope.scopeId, scope.parent, input.threadId);
      if (!thread) throw new ThreadRuntimeError("not-found", `Thread not found: ${input.threadId}`);
      if (thread.kind !== "discussion") {
        throw new ThreadRuntimeError("conflict", "This thread is already an implementation thread");
      }
      if (thread.lifecycle !== "active") {
        throw new ThreadRuntimeError("conflict", `Only an active discussion can be converted (current state: ${thread.lifecycle})`);
      }
      const currentRun = await options.registry.getActiveRun(scope.scopeId, thread.id);
      if (!currentRun?.sessionId || currentRun.workerState !== "running" || currentRun.outcome !== null) {
        throw new ThreadRuntimeError("conflict", "The discussion session is not currently available for conversion");
      }
      const binding = bindingsBySession.get(currentRun.sessionId);
      if (!binding || binding.runId !== currentRun.id || binding.kind !== "discussion") {
        throw new ThreadRuntimeError("unavailable", "The discussion worker must be restored before it can be converted");
      }
      const childSnapshot = await options.sessions.snapshot(currentRun.sessionId);
      if (childSnapshot.busy || childSnapshot.isStreaming || childSnapshot.isCompacting) {
        throw new ThreadRuntimeError("conflict", "Wait for the current discussion response to finish before converting it");
      }

      const tools = scope.snapshot.activeTools.filter((tool) => !THREAD_CONTROL_TOOLS.has(tool));
      const hasMutationTool = tools.some((tool) => {
        const mutation = HARNESS_TOOL_META[tool]?.mutation;
        return mutation === "journaled" || mutation === "process";
      });
      if (!hasMutationTool) {
        throw new ThreadRuntimeError(
          "unavailable",
          "The parent session has no implementation-capable tools to grant this thread",
        );
      }

      if (await options.registry.countActiveInRoot(scope.scopeId, scope.parent) >= thread.manifest.concurrency) {
        throw new ThreadRuntimeError("conflict", "The root task has no free execution slot for implementation conversion");
      }

      try {
        await updateRunMetrics(binding);
      } catch (error) {
        reportError(error);
      }
      const prepared = await options.worktrees.prepare({
        mode: "isolated",
        sourceRoot: childSnapshot.cwd,
        threadId: thread.id,
        signal: abortController.signal,
      });
      if (!prepared.worktree) throw new Error("Implementation conversion did not create an isolated worktree");
      const model = thread.model ?? (childSnapshot.model
        ? { providerId: childSnapshot.model.provider, modelId: childSnapshot.model.id }
        : undefined);
      let converted: Awaited<ReturnType<ThreadRegistry["convertThread"]>>;
      try {
        converted = await options.registry.convertThread(scope.scopeId, thread.id, {
          ...(model ? { model } : {}),
          scope: thread.manifest.scope,
          tools,
          worktree: prepared.worktree,
        });
      } catch (error) {
        if (!(error instanceof ThreadAdmissionError)) throw error;
        // Only a definite admission refusal proves conversion never committed.
        // Keep the live discussion and discard its never-executed input copy.
        await options.worktrees.discardInput?.(prepared.worktree, scope.scopeId).catch(reportError);
        throw new ThreadRuntimeError("conflict", error.message);
      }
      if (!converted) throw new ThreadRuntimeError("not-found", `Thread not found: ${thread.id}`);

      try {
        await closeBinding(binding, false);
      } catch (error) {
        await options.registry.endRun(
          scope.scopeId,
          thread.id,
          converted.run.id,
          "lost",
          `worker restart failed during conversion: ${error instanceof Error ? error.message : String(error)}`,
        ).catch(reportError);
        throw error;
      }

      let opened: SessionSnapshot;
      try {
        const runtimeWorkspaceId = await options.resolveRuntimeWorkspaceId(prepared.cwd);
        opened = await options.sessions.open({
          modelSettings: converted.run.frozen?.modelSettings ?? null,
          cwd: prepared.cwd,
          ...(model ? { model } : {}),
          permissions: normalizeFrozenHarnessPermissions(thread.manifest.permissions),
          ...(thread.manifest.scope.length > 0 ? { scope: [...thread.manifest.scope] } : {}),
          sessionId: currentRun.sessionId,
          tools,
          workFocus: converted.run.frozen!.workFocus,
          workspaceId: runtimeWorkspaceId,
        });
      } catch (error) {
        await options.registry.endRun(
          scope.scopeId,
          thread.id,
          converted.run.id,
          "lost",
          `worker reopen failed during conversion: ${error instanceof Error ? error.message : String(error)}`,
        ).catch(reportError);
        void resumeLostForParent(scope.scopeId, scope.parent).catch(reportError);
        throw error;
      }

      const baselineStats = await options.sessions.stats(opened.sessionId).catch((error) => {
        reportError(error);
        return null;
      });
      const implementationBinding: RuntimeBinding = {
        scopeId: scope.scopeId,
        parent: scope.parent,
        threadId: thread.id,
        runId: converted.run.id,
        sessionId: opened.sessionId,
        cwd: prepared.cwd,
        kind: "implementation",
        providerId: model?.providerId ?? null,
        baseline: {
          cost: baselineStats?.cost ?? 0,
          toolCalls: baselineStats?.toolCalls ?? 0,
          tokens: {
            input: baselineStats?.tokens.input ?? 0,
            output: baselineStats?.tokens.output ?? 0,
            cacheRead: baselineStats?.tokens.cacheRead ?? 0,
          },
        },
      };
      bind(implementationBinding);
      await bindExecutionView({
        sessionId: opened.sessionId,
        scopeId: scope.scopeId,
        parent: scope.parent,
        threadId: thread.id,
        runId: converted.run.id,
      });
      await options.registry.markRunRunning(scope.scopeId, thread.id, converted.run.id, opened.sessionId);
      options.onThreadSessionBound?.(opened.sessionId, scope.scopeId);
      try {
        scheduleStallTimer(implementationBinding);
        await options.sessions.prompt(
          opened.sessionId,
          "The user converted this discussion into an implementation thread.",
        );
      } catch (error) {
        clearStallTimer(opened.sessionId);
        reportError(error);
      }

      const [current, activeRun] = await Promise.all([
        options.registry.getThread(scope.scopeId, scope.parent, thread.id),
        options.registry.getActiveRun(scope.scopeId, thread.id),
      ]);
      if (!current || !activeRun) throw new Error(`Converted thread disappeared: ${thread.id}`);
      return { scopeId: scope.scopeId, parent: scope.parent, thread: current, activeRun };
    });
  };

  const send = async (
    sessionId: string,
    message: string,
    meta: { from: string; requestId?: string; messageId?: string },
  ): Promise<void> => {
    // `from` is a Host-derived sender label; `requestId` travels in the
    // delivered text so the receiver can bind a replyTo to the real request.
    const header = meta.requestId
      ? `Message from ${meta.from} (request ${meta.requestId})`
      : `Message from ${meta.from}`;
    const text = `${header}:\n${message}`;
    if (!meta.requestId) {
      if (!options.sessions.notify) {
        throw new ThreadRuntimeError("unavailable", "The session adapter does not support passive message delivery");
      }
      await options.sessions.notify(sessionId, text, meta.messageId ?? randomUUID());
      return;
    }
    if (!options.sessions.request) throw new ThreadRuntimeError("unavailable", "The session adapter does not support idempotent execution requests");
    await options.sessions.request(sessionId, text, meta.requestId);
  };

  const killOne = async (threadId: string, keepWorktree: boolean, workspaceId?: string): Promise<void> => {
    await waitForPreparation(threadId);
    const sessionId = sessionByThread.get(threadId);
    const binding = sessionId ? bindingsBySession.get(sessionId) : undefined;
    const owningWorkspaceId = workspaceId ?? binding?.scopeId;
    try {
      if (sessionId) {
        if (binding) await closeBinding(binding, true);
        else {
          terminatingSessions.add(sessionId);
          await options.sessions.abort(sessionId).catch(reportError);
          await options.sessions.close(sessionId).catch(reportError);
        }
      }
      if (owningWorkspaceId) await options.stopExperimentsForThread?.(owningWorkspaceId, threadId);
      if (binding) {
        await publishPartialResult(binding.scopeId, binding.parent, threadId).catch(reportError);
        const run = await options.registry.getActiveRun(binding.scopeId, threadId);
        if (run?.id === binding.runId && run.outcome === null) {
          await options.registry.endRun(binding.scopeId, threadId, binding.runId, "cancelled", "killed by parent");
        }
        const killed = await options.registry.getThreadById(binding.scopeId, threadId);
        if (killed?.preset === "retrieval" && killed.worktree && options.worktrees.discardInput) {
          await options.worktrees.discardInput(killed.worktree, binding.scopeId).catch(reportError);
          await options.registry.setWorktree(binding.scopeId, threadId, killed.worktree).catch(reportError);
        }
      }
      if (owningWorkspaceId) {
        const thread = await options.registry.getThreadById(owningWorkspaceId, threadId);
        if (thread && thread.lifecycle !== "archived" && thread.lifecycle !== "settled") {
          await options.registry.cancelThread(owningWorkspaceId, threadId, "killed by parent");
        }
        if (thread && !keepWorktree) {
          // Already holding this thread's lifecycle turn; do not go through
          // opportunistic tryAutoReclaimDirectory, which skips a busy lock.
          await tryReclaimDirectory(owningWorkspaceId, thread.parent, thread).catch(reportError);
        }
      }
      await releasePendingMaterializeReservation(threadId);
    } finally {
      if (sessionId && !binding) {
        if (sessionByThread.get(threadId) === sessionId) sessionByThread.delete(threadId);
        terminatingSessions.delete(sessionId);
      }
    }
  };

  const kill = async (threadId: string, keepWorktree = false, workspaceId?: string): Promise<void> => {
    const owningWorkspaceId = workspaceId ?? resolveWorkspaceIdForThread(threadId);
    if (!owningWorkspaceId) {
      await killOne(threadId, keepWorktree);
      return;
    }
    const releaseCascade = await beginCascade(owningWorkspaceId, threadId);
    try {
      const descendants = await collectDescendantsPostOrder(owningWorkspaceId, threadId);
      for (const child of descendants) {
        await withThreadLifecycle(owningWorkspaceId, child.id, () => (
          killOne(child.id, keepWorktree, owningWorkspaceId)
        ));
      }
      await withThreadLifecycle(owningWorkspaceId, threadId, () => (
        killOne(threadId, keepWorktree, owningWorkspaceId)
      ));
    } finally {
      releaseCascade();
    }
  };

  const merge = async (
    workspaceId: string,
    parent: ThreadParent,
    threadId: string,
    requestedRevision?: number,
    executionId?: string,
    extras?: { sourceOwner?: { ownerId: string; generation: number }; expectedBindingFingerprint?: string; resolutions?: ThreadConflictResolution[]; signal?: AbortSignal },
  ) => {
    const existing = await options.registry.getThread(workspaceId, parent, threadId);
    if (!existing) throw new Error(`Thread not found: ${threadId}`);
    let thread = existing;
    if (!thread.worktree && !thread.workBranchId) throw new Error("Thread has no published work state to merge");
    let parentRoot = await options.resolveWorkspaceRoot(workspaceId);
    let parentAuthority: { kind: "branch"; branchId: string; sessionId?: string } | { kind: "directory"; directory: string; workspaceId?: string } | undefined;
    let releaseParentWrite = (): void => undefined;
    if (parent.kind === "thread") {
      const owner = await options.registry.getThreadById(workspaceId, parent.id);
      if (!owner) throw new Error(`Parent thread not found: ${parent.id}`);
      const parentRun = await options.registry.getActiveRun(workspaceId, parent.id);
      const parentSessionId = parentRun?.sessionId;
      if (owner.workBranchId && parentSessionId && options.virtualWriteGate && options.executionViews) {
        const ticket = await acquireVirtualWriteTicket(
          options.virtualWriteGate,
          parentSessionId,
          () => {
            const view = options.executionViews?.get(parentSessionId);
            return !!view && view.mode === "virtual";
          },
          extras?.signal,
        );
        if (ticket !== "disk") releaseParentWrite = () => ticket.finish();
        try {
          const latest = await options.registry.getThreadById(workspaceId, parent.id);
          if (ticket !== "disk") {
            parentAuthority = {
              kind: "branch",
              branchId: latest?.workBranchId ?? owner.workBranchId,
              sessionId: parentSessionId,
            };
          } else {
            if (latest?.worktree?.path && latest.worktree.materialized !== false && !isVirtualWorktree(latest.worktree)) {
              parentRoot = latest.worktree.path;
              parentAuthority = {
                kind: "directory",
                directory: latest.worktree.path,
                workspaceId: await options.resolveRuntimeWorkspaceId(latest.worktree.path),
              };
            } else if (usesWorkingBranchAuthority(latest)) {
              parentAuthority = {
                kind: "branch",
                branchId: latest!.workBranchId!,
                sessionId: parentSessionId,
              };
            } else {
              throw new Error(`Parent thread write authority is unavailable: ${parent.id}`);
            }
          }
        } catch (error) {
          releaseParentWrite();
          throw error;
        }
      } else if (usesWorkingBranchAuthority(owner)) {
        parentAuthority = {
          kind: "branch",
          branchId: owner.workBranchId!,
          ...(parentSessionId ? { sessionId: parentSessionId } : {}),
        };
      } else if (owner.worktree?.path && owner.worktree.materialized !== false && !isVirtualWorktree(owner.worktree)) {
        parentRoot = owner.worktree.path;
        parentAuthority = {
          kind: "directory",
          directory: owner.worktree.path,
          workspaceId: await options.resolveRuntimeWorkspaceId(owner.worktree.path),
        };
      } else {
        throw new Error(`Parent thread write authority is unavailable: ${parent.id}`);
      }
    }
    let coordinator: Pick<IntegrationCoordinator, "mergeResult" | "previewResult" | "undoIntegration" | "invalidateWorkspace"> | null;
    try {
      coordinator = options.resolveIntegrationCoordinator
        ? await options.resolveIntegrationCoordinator(workspaceId)
        : null;
    } catch (error) {
      releaseParentWrite();
      throw error;
    }
    const operation = async () => {
      const branchId = thread.workBranchId;
      const resultRevision = requestedRevision ?? thread.resultRevision;
      if (thread.manifest.draftBaselineId && (!coordinator || !options.workingStates || !branchId || !resultRevision)) {
        throw new Error("Thread draft baseline requires a published native result for integration");
      }
      if (coordinator && branchId && resultRevision) {
        const result = await coordinator.mergeResult({
          workspaceId,
          threadId,
          branchId,
          resultRevision,
          ...(executionId ? { executionId, requireTurnBinding: true } : {}),
          ...(extras?.sourceOwner ? { sourceOwner: extras.sourceOwner } : {}),
          ...(extras?.expectedBindingFingerprint ? { expectedBindingFingerprint: extras.expectedBindingFingerprint } : {}),
          ...(extras?.signal ? { signal: extras.signal } : {}),
          ...(extras?.resolutions ? { resolutions: extras.resolutions } : {}),
          ...(parentAuthority ? { parentAuthority } : {}),
        });
        if (result.preview) {
          const pendingSurface = result.preview.paths.some((path) => (
            path.target === "surface"
            && path.phase !== "surface-applied"
            && path.phase !== "skipped-identical"
          ));
          const failed = result.status === "compensated"
            || result.status === "needs-attention"
            || result.preview.unavailablePaths.length > 0
            || result.preview.conflictPaths.length > 0;
          await options.registry.setIntegration(
            workspaceId,
            threadId,
            failed ? "conflict" : pendingSurface ? (result.preview.mergeReady ? "merge-ready" : "dirty") : "merged",
            result.diffStats,
            undefined,
            failed || pendingSurface ? undefined : resultRevision,
          );
          await options.registry.setIntegrationBinding(
            workspaceId,
            threadId,
            threadIntegrationBindingFromPreview(result.preview),
          );
          if (options.verification && options.workingStates && resultRevision) {
            const fullyIntegrated = result.status === "applied" && !failed && !pendingSurface;
            const draftUnsaved = fullyIntegrated && result.preview.surfaceTargetPaths.length > 0;
            const parentSessionId = parent.kind === "session"
              ? parent.id
              : (await options.registry.getActiveRun(workspaceId, parent.id))?.sessionId ?? null;
            const parentIdentity = !fullyIntegrated
              ? { treeHash: null, reason: pendingSurface
                  ? "unsaved surface targets are outside disk command identity"
                  : "integration did not completely apply" }
              : draftUnsaved
                ? { treeHash: null, reason: "integrated surface targets remain in unsaved editor buffers" }
              : await options.verification.captureParentInput(workspaceId, parentRoot);
            await projectVerification(workspaceId, threadId, resultRevision, (store) => (
              options.verification!.recordParentMerge(store, {
                workspaceId,
                parent,
                parentRoot,
                parentSessionId,
                threadId,
                branchId,
                mergedResultRevision: resultRevision,
                mergeOperationId: result.operationId,
                integrated: fullyIntegrated,
                draftUnsaved,
                parentIdentity,
              })
            )).catch(reportError);
          }
        }
        return {
          merged: result.appliedPaths.length,
          conflicts: [...new Set([...result.conflictPaths, ...(result.needsAttentionPaths ?? [])])],
          conflictState: result.conflictPaths.some((file) => result.appliedPaths.includes(file))
            ? "markers" as const
            : result.conflictPaths.length > 0 ? "parent-unchanged" as const : "none" as const,
          changedFiles: result.changedFiles,
          diffStats: result.diffStats,
          appliedPaths: result.appliedPaths,
          ...(result.surfaceTargetPaths ? { surfaceTargetPaths: result.surfaceTargetPaths } : {}),
          ...(result.preview ? { preview: result.preview } : {}),
          status: result.status,
          resultRevision,
          operationId: result.operationId,
        };
      }
      if (requestedRevision !== undefined) throw new Error(`Native thread result revision is unavailable: ${requestedRevision}`);
      if (thread.workBranchId) {
        throw new Error("Thread native result is unavailable; publish a successful result before merging");
      }
      if (!thread.worktree?.resultCommit) throw new Error("Thread has no fixed published result to merge");
      return options.worktrees.merge(parentRoot, thread.worktree);
    };
    try {
      return await withThreadLifecycle(workspaceId, threadId, async () => {
        const latest = await options.registry.getThread(workspaceId, parent, threadId);
        if (!latest) throw new Error(`Thread not found: ${threadId}`);
        if (latest.deletion) throw new Error("Cannot merge a thread while deletion is pending");
        if (latest.lifecycle === "archived") throw new Error("Cannot merge an archived thread");
        thread = latest;
        return options.withMergeWriter
          ? options.withMergeWriter(workspaceId, threadId, operation)
          : operation();
      });
    } finally {
      releaseParentWrite();
    }
  };

  /**
   * Incorporate a selected published parent result revision into a started
   * child thread's working baseline (D-286/3.18D). The child's base moves to
   * the immutable parent result while its effective edits are preserved via
   * three-way planning; conflicts keep the child's bytes and are reported.
   */
  const updateBaseline = async (
    workspaceId: string,
    parent: ThreadParent,
    threadId: string,
    revision?: number,
    extras?: { signal?: AbortSignal },
  ) => {
    if (!options.workingStates) throw new Error("Persistent working state is unavailable for baseline updates");
    const existing = await options.registry.getThread(workspaceId, parent, threadId);
    if (!existing) throw new Error(`Thread not found: ${threadId}`);
    if (!existing.workBranchId) {
      throw new Error(`Thread ${threadId} has no working branch baseline to update`);
    }
    if (existing.parent?.kind !== "thread") {
      throw new Error(`Thread ${threadId} has no parent thread to incorporate a baseline from`);
    }
    const owner = await options.registry.getThreadById(workspaceId, existing.parent.id);
    if (!owner?.workBranchId) throw new Error(`Parent thread working branch is unavailable: ${existing.parent.id}`);
    const targetRevision = revision ?? owner.resultRevision;
    if (targetRevision === undefined) {
      throw new Error(`Parent thread ${owner.id} has no published result revision to incorporate`);
    }
    const childBranchId = existing.workBranchId;
    const parentBranchId = owner.workBranchId;
    const operation = async () => {
      const outcome = await options.workingStates!.withBranchStore(
        workspaceId,
        "thread-baseline-update",
        (store) => rebaseBranchOntoParentRevision(store, childBranchId, parentBranchId, targetRevision, { ...(extras?.signal ? { signal: extras.signal } : {}) }),
        "exclusive",
      );
      if (outcome.status !== "committed") {
        return {
          status: "conflict" as const,
          threadId,
          resultRevision: targetRevision,
          baseRef: `${parentBranchId}@${targetRevision}`,
          updatedFromParent: [] as string[],
          keptPaths: [] as string[],
          mergedPaths: [] as string[],
          conflicts: [] as { path: string; reason?: string }[],
          message: `Thread ${threadId} kept changing while its baseline was being updated; retry the update`,
        };
      }
      const latest = await options.registry.getThread(workspaceId, parent, threadId);
      const worktree = latest?.worktree ? { ...latest.worktree } : null;
      if (worktree) {
        worktree.base = `${parentBranchId}@${targetRevision}`;
        await options.registry.setWorktree(workspaceId, threadId, worktree);
      }
      return {
        status: "applied" as const,
        threadId,
        resultRevision: targetRevision,
        baseRef: `${parentBranchId}@${targetRevision}`,
        updatedFromParent: outcome.updatedFromParent,
        keptPaths: outcome.keptChildPaths,
        mergedPaths: outcome.mergedPaths,
        conflicts: outcome.conflicts,
      };
    };
    return withThreadLifecycle(workspaceId, threadId, async () => {
      const latest = await options.registry.getThread(workspaceId, parent, threadId);
      if (!latest) throw new Error(`Thread not found: ${threadId}`);
      if (latest.deletion) throw new Error("Cannot update the baseline of a thread while deletion is pending");
      if (latest.lifecycle === "archived" && !latest.worktree?.baselineUpdate) {
        throw new Error("Cannot update the baseline of an archived thread");
      }
      if (latest.worktree && latest.worktree.materialized !== false && !isVirtualWorktree(latest.worktree)) {
        if (!options.resolveBaselineApplyContext || !options.canReclaimWorktree) {
          throw new ThreadRuntimeError("unavailable", "Materialized baseline updates require execution-directory authority");
        }
        await ownershipAssertion(latest.worktree)("baseline-update");
        const guard = await options.canReclaimWorktree(workspaceId, threadId, latest.worktree.path);
        if (!guard.safe) throw new ThreadRuntimeError("conflict", guard.reason ?? "Execution directory is in use", { retryable: true });
        try {
          return await updateMaterializedBaseline({
            workingStates: options.workingStates!, workspaceId, threadId, branchId: childBranchId,
            parentBranchId, parentRevision: targetRevision, worktree: latest.worktree,
            resolveDirectoryApplyContext: options.resolveBaselineApplyContext,
            persist: async (updated) => {
              if (!await options.registry.setWorktree(workspaceId, threadId, updated)) throw new Error("Thread disappeared during baseline update");
            },
            ...(extras?.signal ? { signal: extras.signal } : {}),
          });
        } catch (error) {
          const pending = await options.registry.getThread(workspaceId, parent, threadId);
          if (pending?.worktree?.baselineUpdate) {
            // No next model turn may build on an unfinished native/Registry handoff.
            const sessionId = sessionByThread.get(threadId);
            const binding = sessionId ? bindingsBySession.get(sessionId) : undefined;
            if (binding) await closeBinding(binding, true);
            await options.registry.setAttention(workspaceId, threadId, "stalled");
          }
          throw error;
        } finally { await guard.release?.(); }
      }
      const run = await options.registry.getActiveRun(workspaceId, threadId);
      let release = () => {};
      if (run?.sessionId && options.virtualWriteGate && options.executionViews) {
        // Acquire before opening the store; materialization waits on this gate.
        const ticket = await acquireVirtualWriteTicket(options.virtualWriteGate, run.sessionId,
          () => options.executionViews?.get(run.sessionId!)?.mode === "virtual", extras?.signal);
        if (ticket === "disk") throw new ThreadRuntimeError("conflict", "Thread changed execution authority; retry baseline update", { retryable: true });
        release = ticket.finish;
      }
      try { return await operation(); } finally { release(); }
    });
  };

  const previewIntegration = async (
    workspaceId: string,
    parent: ThreadParent,
    threadId: string,
    extras?: { resultRevision?: number; sourceOwner?: { ownerId: string; generation: number }; expectedBindingFingerprint?: string; resolutions?: ThreadConflictResolution[]; signal?: AbortSignal },
  ) => {
    const thread = await options.registry.getThread(workspaceId, parent, threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    const coordinator = options.resolveIntegrationCoordinator
      ? await options.resolveIntegrationCoordinator(workspaceId)
      : null;
    const branchId = thread.workBranchId;
    const resultRevision = extras?.resultRevision ?? thread.resultRevision;
    if (!coordinator || !branchId || resultRevision === undefined) {
      throw new Error("Thread has no published native result to preview");
    }
    let parentAuthority: { kind: "branch"; branchId: string; sessionId?: string } | { kind: "directory"; directory: string; workspaceId?: string } | undefined;
    if (parent.kind === "thread") {
      const owner = await options.registry.getThreadById(workspaceId, parent.id);
      if (!owner) throw new Error(`Parent thread not found: ${parent.id}`);
      const parentRun = await options.registry.getActiveRun(workspaceId, parent.id);
      if (usesWorkingBranchAuthority(owner)) {
        parentAuthority = {
          kind: "branch",
          branchId: owner.workBranchId!,
          ...(parentRun?.sessionId ? { sessionId: parentRun.sessionId } : {}),
        };
      } else if (owner?.worktree?.path && owner.worktree.materialized !== false && !isVirtualWorktree(owner.worktree)) {
        parentAuthority = {
          kind: "directory",
          directory: owner.worktree.path,
          workspaceId: await options.resolveRuntimeWorkspaceId(owner.worktree.path),
        };
      } else {
        throw new Error(`Parent thread write authority is unavailable: ${parent.id}`);
      }
    }
    const preview = await coordinator.previewResult({
      workspaceId,
      threadId,
      branchId,
      resultRevision,
      ...(extras?.sourceOwner ? { sourceOwner: extras.sourceOwner } : {}),
      ...(extras?.expectedBindingFingerprint ? { expectedBindingFingerprint: extras.expectedBindingFingerprint } : {}),
      ...(extras?.signal ? { signal: extras.signal } : {}),
      ...(extras?.resolutions ? { resolutions: extras.resolutions } : {}),
      ...(parentAuthority ? { parentAuthority } : {}),
    });
    await options.registry.setIntegration(
      workspaceId,
      threadId,
      preview.mergeReady ? "merge-ready" : preview.conflictPaths.length > 0 || preview.unavailablePaths.length > 0
        ? "conflict"
        : "dirty",
      thread.diffStats,
    );
    await options.registry.setIntegrationBinding(workspaceId, threadId, threadIntegrationBindingFromPreview(preview));
    return preview;
  };

  const isEnospc = (error: unknown): boolean => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOSPC") return true;
    const message = error instanceof Error ? error.message : String(error);
    return /\bENOSPC\b|no space left/i.test(message);
  };

  const unfinishedIntegrationReasons = async (workspaceId: string, threadId: string): Promise<string[]> => {
    const reasons: string[] = [];
    // `dirty`/`merge-ready`/`conflict` are projections of a persisted result.
    // Only a still-running integration operation owns the directory.
    if (!options.workingStates) return reasons;
    const operations = await options.workingStates.withBranchStore(workspaceId, "thread-space-ops", async (store) => (
      (await store.listDurableOperations("integration")).flatMap((row) => {
        const data = row.data && typeof row.data === "object" && !Array.isArray(row.data) ? row.data as Record<string, unknown> : {};
        const state = String(row.state ?? "");
        return data.threadId === threadId && !["complete", "conflict", "compensated", "aborted", "undone"].includes(state)
          ? [`Unfinished integration operation ${String(row.operationId ?? "unknown")} (${state})`] : [];
      })
    ), "shared");
    return [...reasons, ...operations];
  };

  const keepReasonsFor = async (workspaceId: string, thread: Thread): Promise<string[]> => {
    const run = await options.registry.getActiveRun(workspaceId, thread.id);
    const runActive = Boolean(run && run.outcome === null);
    let matchesResult: boolean | null = null;
    const hasPublishedResult = Boolean(thread.workBranchId && thread.resultRevision);
    if (hasPublishedResult && thread.worktree && thread.worktree.materialized !== false && options.workingStates) {
      try {
        matchesResult = await options.workingStates.withBranchStore(
          workspaceId,
          "thread-result-reclaim-check",
          (store) => store.directoryMatchesResult(thread.workBranchId!, thread.resultRevision!, thread.worktree!.path),
          "shared",
          { executionWorkspace: await options.resolveRuntimeWorkspaceId(thread.worktree!.path) },
        );
      } catch {
        matchesResult = null;
      }
    } else if (thread.worktree?.materialized === false) {
      matchesResult = true;
    }
    const hasActiveCommands = Boolean(
      thread.worktree
      && thread.worktree.materialized !== false
      && options.hasActiveCommands
      && await options.hasActiveCommands(thread.worktree.path),
    );
    return assembleKeepReasons({
      thread,
      runActive,
      unfinishedIntegration: await unfinishedIntegrationReasons(workspaceId, thread.id),
      matchesResult,
      hasPublishedResult,
      hasActiveCommands,
    });
  };

  const occupancyFor = async (
    workspaceId: string,
    thread: Thread,
    exclusive: Map<string, number | null>,
    shared: Map<string, number | null>,
  ): Promise<ThreadOccupancy> => {
    const materialized = !thread.worktree || thread.worktree.materialized === false
      ? { logicalBytes: 0, allocatedBytes: 0, unknown: false }
      : await (options.measureManagedDirectory
        ? options.measureManagedDirectory(workspaceId, thread.worktree)
        : measureDirectory(thread.worktree.path)).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { logicalBytes: null, allocatedBytes: null, unknown: true };
          }
          throw error;
        });
    const occupancyInput: Parameters<typeof projectThreadOccupancy>[0] = {
      thread,
      materialized,
      exclusive,
      shared,
      keepReasons: await keepReasonsFor(workspaceId, thread),
    };
    const cow = cowByThread.get(thread.id);
    if (cow) occupancyInput.cow = cow;
    return projectThreadOccupancy(occupancyInput);
  };

  const objectHashMaps = async (workspaceId: string, threads: Thread[]): Promise<Map<string, Map<string, number | null>>> => {
    const perThread = new Map<string, Map<string, number | null>>();
    if (!options.workingStates) {
      for (const thread of threads) perThread.set(thread.id, new Map());
      return perThread;
    }
    return options.workingStates.withBranchStore(workspaceId, "thread-space-measure", async (store) => {
      for (const thread of threads) {
        const branchHashes = thread.workBranchId ? await collectBranchObjectHashesFromRoot(store, thread.workBranchId) : new Map();
        const draftHashes = await collectDraftBaselineHashesFromRoot(store, thread.manifest.draftBaselineId);
        perThread.set(thread.id, mergeHashMaps(branchHashes, draftHashes));
      }
      return perThread;
    }, "shared");
  };

  const inspectSpace = async (workspaceId: string, parent?: ThreadParent): Promise<WorkspaceThreadSpace> => {
    // Space is a workspace budget and object graph. `parent` is retained by
    // the route as a presentation scope, but must never narrow accounting.
    const listed = await options.registry.listWorkspaceThreads(workspaceId);
    const threads = listed.filter((thread) => !thread.hidden);
    const perThreadHashes = await objectHashMaps(workspaceId, threads);
    const owners = new Map<string, Set<string>>();
    const unique = new Map<string, number | null>();
    for (const [threadId, hashes] of perThreadHashes) {
      for (const [hash, size] of hashes) {
        const current = owners.get(hash) ?? new Set<string>();
        current.add(threadId);
        owners.set(hash, current);
        if (!unique.has(hash)) unique.set(hash, size);
        else if (unique.get(hash) === null || size === null) unique.set(hash, null);
      }
    }
    const occupancies: ThreadOccupancy[] = [];
    for (const thread of threads) {
      const hashes = perThreadHashes.get(thread.id) ?? new Map();
      const exclusive = new Map<string, number | null>();
      const shared = new Map<string, number | null>();
      for (const [hash, size] of hashes) {
        if ((owners.get(hash)?.size ?? 1) > 1) shared.set(hash, size);
        else exclusive.set(hash, size);
      }
      occupancies.push(await occupancyFor(workspaceId, thread, exclusive, shared));
    }
    const settings = parent
      ? await resolveEffectiveWorktreeSettings(workspaceId, parent)
      : options.worktreeSettings;
    let volume: { freeBytes: number; totalBytes: number } | null = null;
    try {
      volume = await readVolumeSpace(await options.resolveWorkspaceRoot(workspaceId));
    } catch {
      volume = null;
    }
    return projectWorkspaceSpace(workspaceId, occupancies, measurementFromHashes(unique), settings?.budget, volume);
  };

  const tryReclaimDirectory = async (
    workspaceId: string,
    parent: ThreadParent,
    thread: Thread,
  ): Promise<{ thread: Thread; reclaimed: boolean; occupancy: ThreadOccupancy; message?: string }> => {
    const space = await inspectSpace(workspaceId, parent);
    const occupancy = space.threads.find((entry) => entry.threadId === thread.id)
      ?? await occupancyFor(workspaceId, thread, new Map(), new Map());
    const current = await options.registry.getThread(workspaceId, parent, thread.id) ?? thread;
    if (!current.worktree) {
      return { thread: current, reclaimed: true, occupancy };
    }
    if (current.worktree.baselineUpdate) return {
      thread: current, reclaimed: false, occupancy,
      message: `Baseline update ${current.worktree.baselineUpdate.operationId} still needs reconciliation`,
    };
    if (current.worktree.materialized === false && !isVirtualWorktree(current.worktree)) {
      try {
        await fs.promises.lstat(current.worktree.path);
        current.worktree.retentionReason = "Original thread path contains uncollected content";
        await persistWorktree(workspaceId, current.id, current.worktree).catch(reportError);
        return {
          thread: await options.registry.getThread(workspaceId, parent, current.id) ?? current,
          reclaimed: false,
          occupancy,
          message: current.worktree.retentionReason,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          if (current.worktree.retentionReason) {
            return {
              thread: current,
              reclaimed: false,
              occupancy,
              message: current.worktree.retentionReason,
            };
          }
          return { thread: current, reclaimed: true, occupancy };
        }
        current.worktree.retentionReason = error instanceof Error ? error.message : String(error);
        await persistWorktree(workspaceId, current.id, current.worktree).catch(reportError);
        return {
          thread: await options.registry.getThread(workspaceId, parent, current.id) ?? current,
          reclaimed: false,
          occupancy,
          message: current.worktree.retentionReason,
        };
      }
    }
    if (occupancy.keepReasons.length > 0 || !occupancy.reclaimable) {
      current.worktree.retentionReason = occupancy.keepReasons.join("; ") || "Directory is not reclaimable";
      await persistWorktree(workspaceId, current.id, current.worktree);
      return {
        thread: await options.registry.getThread(workspaceId, parent, current.id) ?? current,
        reclaimed: false,
        occupancy,
        message: current.worktree.retentionReason,
      };
    }
    if (!options.worktrees.reclaim) {
      return { thread: current, reclaimed: false, occupancy, message: "Worktree reclamation is unavailable" };
    }
    // The observation above is only a candidate check. Re-read all mutable
    // ownership facts after acquiring the real guard, and keep that guard
    // until the physical delete has completed.
    let permission: { safe: boolean; reason?: string; release?: () => Promise<void> };
    try {
      permission = options.canReclaimWorktree
        ? await options.canReclaimWorktree(workspaceId, current.id, current.worktree.path)
        : { safe: false, reason: "No worktree user/writer authority is configured" };
    } catch (error) {
      current.worktree.retentionReason = error instanceof Error ? error.message : String(error);
      await persistWorktree(workspaceId, current.id, current.worktree).catch(reportError);
      return {
        thread: await options.registry.getThread(workspaceId, parent, current.id) ?? current,
        reclaimed: false,
        occupancy,
        message: current.worktree.retentionReason,
      };
    }
    try {
      if (!permission.safe) {
        current.worktree.retentionReason = permission.reason ?? "The worktree still has an active user or writer";
        await persistWorktree(workspaceId, current.id, current.worktree);
        return {
          thread: await options.registry.getThread(workspaceId, parent, current.id) ?? current,
          reclaimed: false,
          occupancy,
          message: current.worktree.retentionReason,
        };
      }
      const latest = await options.registry.getThread(workspaceId, parent, current.id) ?? current;
      const latestRun = await options.registry.getActiveRun(workspaceId, current.id);
      const latestReasons = await keepReasonsFor(workspaceId, latest);
      if (latestRun?.outcome === null || latestReasons.length > 0
        || !latest.worktree
        || (latest.worktree.materialized === false && !isVirtualWorktree(latest.worktree))
        || latest.worktree.path !== current.worktree.path) {
        current.worktree.retentionReason = latestReasons[0] ?? "Thread changed while worktree reclamation was starting";
        await persistWorktree(workspaceId, current.id, current.worktree);
        return {
          thread: await options.registry.getThread(workspaceId, parent, current.id) ?? current,
          reclaimed: false,
          occupancy,
          message: current.worktree.retentionReason,
        };
      }
      if (latest.workBranchId && latest.resultRevision && options.workingStates && !isVirtualWorktree(latest.worktree)) {
        const matches = await options.workingStates.withBranchStore(
          workspaceId,
          "thread-result-reclaim-check",
          (store) => store.directoryMatchesResult(latest.workBranchId!, latest.resultRevision!, latest.worktree!.path),
          "shared",
          { executionWorkspace: await options.resolveRuntimeWorkspaceId(latest.worktree!.path) },
        ).catch(() => false);
        if (!matches) {
          current.worktree.retentionReason = "Worktree changed after its latest result was published";
          await persistWorktree(workspaceId, current.id, current.worktree);
          return {
            thread: await options.registry.getThread(workspaceId, parent, current.id) ?? current,
            reclaimed: false,
            occupancy,
            message: current.worktree.retentionReason,
          };
        }
      }
      const nativeVerified = Boolean(latest.workBranchId && latest.resultRevision);
      let result: { reclaimed: boolean; reason?: string };
      try {
        result = await options.worktrees.reclaim(latest.worktree, {
          workspaceId,
          ...(nativeVerified ? { nativeVerified: true } : {}),
        });
      } catch (error) {
        latest.worktree.retentionReason = error instanceof Error ? error.message : String(error);
        await persistWorktree(workspaceId, latest.id, latest.worktree).catch(reportError);
        return {
          thread: await options.registry.getThread(workspaceId, parent, latest.id) ?? latest,
          reclaimed: false,
          occupancy,
          message: latest.worktree.retentionReason,
        };
      }
      if (result.reclaimed) delete latest.worktree.retentionReason;
      else latest.worktree.retentionReason = result.reason ?? "Worktree reclamation was not safe";
      await persistWorktree(workspaceId, latest.id, latest.worktree);
      const updated = await options.registry.getThread(workspaceId, parent, latest.id) ?? latest;
      const nextSpace = await inspectSpace(workspaceId, parent);
      return {
        thread: updated,
        reclaimed: result.reclaimed,
        occupancy: nextSpace.threads.find((entry) => entry.threadId === latest.id) ?? occupancy,
        ...(result.reclaimed ? {} : { message: latest.worktree.retentionReason }),
      };
    } finally {
      await permission.release?.();
    }
  };

  const tryAutoReclaimDirectory = async (
    workspaceId: string,
    parent: ThreadParent,
    threadId: string,
  ): Promise<boolean> => {
    // Automatic cleanup is opportunistic. It must never wait on a target
    // thread that is preparing/restoring, because the caller may itself hold a
    // different thread lifecycle turn while reserving workspace budget.
    if (preparations.has(threadId)) return false;
    return tryWithThreadLifecycle(workspaceId, threadId, async () => {
      if (preparations.has(threadId)) return;
      const current = await options.registry.getThread(workspaceId, parent, threadId);
      if (!current || preparations.has(threadId)) return;
      await tryReclaimDirectory(workspaceId, parent, current);
    });
  };

  const reclaimEligibleOthers = async (workspaceId: string, parent: ThreadParent, exceptThreadId: string): Promise<void> => {
    const space = await inspectSpace(workspaceId, parent);
    for (const occupancy of space.threads) {
      if (occupancy.threadId === exceptThreadId || !occupancy.reclaimable) continue;
      const thread = (await options.registry.listWorkspaceThreads(workspaceId)).find((entry) => entry.id === occupancy.threadId);
      if (!thread) continue;
      await tryAutoReclaimDirectory(workspaceId, thread.parent, thread.id).catch(reportError);
    }
  };

  const stopRunForArchive = async (
    workspaceId: string,
    parent: ThreadParent,
    threadId: string,
    opts?: { capturePartial?: boolean; reason?: string },
  ): Promise<void> => {
    const capturePartial = opts?.capturePartial !== false;
    const reason = opts?.reason ?? "archived by user";
    await waitForPreparation(threadId);
    const sessionId = sessionByThread.get(threadId);
    const binding = sessionId ? bindingsBySession.get(sessionId) : undefined;
    const run = await options.registry.getActiveRun(workspaceId, threadId);
    if (!sessionId && run?.outcome === null && run.sessionId) {
      throw new ThreadRuntimeError("unavailable", "The active thread session is not available to stop; retry after it is restored");
    }
    const failures: string[] = [];
    if (sessionId && !binding) {
      throw new ThreadRuntimeError("unavailable", "The active thread session binding is unavailable to stop safely");
    }
    if (sessionId && binding && !binding.archiveStopConfirmed) {
      terminatingSessions.add(sessionId);
      let closeSucceeded = false;
      try { await options.sessions.abort(sessionId); } catch (error) {
        // A successful close is the authoritative stop confirmation. Some
        // providers reject abort after an earlier cancellation even though the
        // still-required close can complete normally.
        reportError(error);
      }
      try {
        await options.sessions.close(sessionId);
        closeSucceeded = true;
      } catch (error) {
        failures.push(`Unable to close thread session: ${error instanceof Error ? error.message : String(error)}`);
        reportError(error);
      }
      if (closeSucceeded) binding.archiveStopConfirmed = true;
    }
    if (failures.length > 0) {
      throw new ThreadRuntimeError("unavailable", failures.join("; "));
    }
    if (run && run.outcome === null) {
      if (capturePartial) {
        try {
          await publishPartialResult(workspaceId, parent, threadId);
        } catch (error) {
          reportError(error);
          throw new ThreadRuntimeError("unavailable", `Unable to capture the thread result before archive: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
      }
      try {
        await options.registry.endRun(workspaceId, threadId, run.id, "cancelled", reason);
      } catch (error) {
        reportError(error);
        throw new ThreadRuntimeError("unavailable", `Unable to settle the thread Run before archive: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
    if (sessionId && bindingsBySession.get(sessionId) === binding) bindingsBySession.delete(sessionId);
    if (sessionByThread.get(threadId) === sessionId) sessionByThread.delete(threadId);
    if (sessionId) {
      lastAgentEnd.delete(sessionId);
      clearStallTimer(sessionId);
      waitingSessions.delete(sessionId);
      terminatingSessions.delete(sessionId);
    }
    stalledThreads.delete(`${workspaceId}\0${threadId}`);
    await releasePendingMaterializeReservation(threadId);
  };

  const suspendForBot = async (workspaceId: string, threadId: string): Promise<void> => {
    preparations.get(threadId)?.controller.abort();
    await withThreadLifecycle(workspaceId, threadId, async () => {
      preparations.get(threadId)?.controller.abort();
      const thread = await options.registry.getThreadById(workspaceId, threadId);
      if (!thread) return;
      await stopRunForArchive(workspaceId, thread.parent, threadId, { reason: "Bot sleeping" });
      await options.stopExperimentsForThread?.(workspaceId, threadId);
    });
  };

  const archiveOneNode = async (
    workspaceId: string,
    parent: ThreadParent,
    threadId: string,
    keepWorktree?: boolean,
  ) => {
    const thread = await options.registry.getThread(workspaceId, parent, threadId);
    if (!thread) throw new ThreadRuntimeError("not-found", `Thread not found: ${threadId}`);
    if (thread.lifecycle !== "archived" || preparations.has(threadId) || sessionByThread.has(threadId)) {
      await stopRunForArchive(workspaceId, parent, threadId);
    }
    const archived = await options.registry.archiveThread(workspaceId, threadId, keepWorktree);
    if (!archived) throw new ThreadRuntimeError("not-found", `Thread not found: ${threadId}`);
    const shouldKeep = archived.keepWorktree === true;
    const reclaimed = shouldKeep
      ? { thread: archived, reclaimed: false, occupancy: await occupancyFor(workspaceId, archived, new Map(), new Map()), message: "User requested keep_worktree" }
      : await tryReclaimDirectory(workspaceId, parent, archived);
    return {
      ...await snapshotFor(workspaceId, parent, archived.id),
      occupancy: reclaimed.occupancy,
      space: await inspectSpace(workspaceId, parent),
      reclaimed: reclaimed.reclaimed,
      ...(reclaimed.message ? { message: reclaimed.message } : {}),
    };
  };

  const archiveUser = async (
    workspaceId: string,
    parent: ThreadParent,
    threadId: string,
    keepWorktree?: boolean,
  ) => {
    // Archive cancels descendant and target preparation before taking any
    // thread lock, then archives each descendant on its own lifecycle turn.
    preparations.get(threadId)?.controller.abort();
    const releaseCascade = await beginCascade(workspaceId, threadId);
    try {
      const descendants = await collectDescendantsPostOrder(workspaceId, threadId);
      for (const child of descendants) {
        preparations.get(child.id)?.controller.abort();
        await withThreadLifecycle(workspaceId, child.id, async () => {
          preparations.get(child.id)?.controller.abort();
          return archiveOneNode(workspaceId, child.parent, child.id, keepWorktree);
        });
      }
      return await withThreadLifecycle(workspaceId, threadId, async () => {
        preparations.get(threadId)?.controller.abort();
        return archiveOneNode(workspaceId, parent, threadId, keepWorktree);
      });
    } finally {
      releaseCascade();
    }
  };

  /**
   * D-242: remove every Pi session a Thread owned —live or ended. Each run's
   * sessionId and the report's transcript session go through the runtime
   * broker, which settles the worker, deletes the session file, and clears
   * metadata. The durable deletion marker survives the broker's archive-by-
   * session projection when a later cleanup phase needs retry.
   */
  const deleteThreadSessions = async (workspaceId: string, threadId: string): Promise<string[]> => {
    const sessionIds = new Set<string>();
    for (const run of await options.registry.listRuns(workspaceId, threadId)) {
      if (run.sessionId && run.sessionOwner === "spawned-child") sessionIds.add(run.sessionId);
    }
    const live = sessionByThread.get(threadId);
    if (live) sessionIds.add(live);
    const thread = await options.registry.getThreadById(workspaceId, threadId);
    const report = thread?.report;
    const transcript = report?.transcriptRef.sessionId;
    if (transcript && thread?.purpose !== "research-root") sessionIds.add(transcript);
    if (sessionIds.size === 0) return [];
    if (!options.deleteSession) {
      throw new ThreadRuntimeError("unavailable", "Session deletion is unavailable; the thread's transcripts would be left behind");
    }
    for (const sessionId of sessionIds) {
      // Delete the session's event/block/session knowledge nodes through the
      // owning workspace before the runtime broker removes its session binding.
      // A retry is idempotent; failure leaves the transcript and binding intact.
      if (options.deleteKnowledgeSession) {
        await options.deleteKnowledgeSession(workspaceId, sessionId);
      }
      await options.deleteSession(sessionId);
    }
    return [...sessionIds];
  };

  /**
   * D-242: release the Thread's persisted working-state objects —every result
   * revision, the work branch head, and the dispatch-time draft baseline —then
   * collect objects that lost their last reference.
   */
  const releaseThreadStore = async (workspaceId: string, thread: Thread): Promise<void> => {
    const branchId = thread.workBranchId;
    const draftBaselineId = thread.manifest.draftBaselineId ?? null;
    if (options.workingStates) {
      await options.workingStates.withBranchStore(workspaceId, "thread-delete", async (store) => {
        if (thread.worktree?.baselineUpdate?.stageBranchId) {
          await store.deleteBranch(thread.worktree.baselineUpdate.stageBranchId);
        }
        if (branchId && thread.worktree?.materializationHandoff?.pinId) {
          await store.releaseBranchHandoffPin?.(branchId, thread.worktree.materializationHandoff.pinId);
        }
        if (branchId) {
          await store.deleteBranch(branchId);
        }
        if (draftBaselineId) await store.deleteDraftBaseline(draftBaselineId);
        try {
          await store.collectUnreachableObjects();
        } catch (error) {
          // Metadata is the logical authority —rows are gone; unreachable-object
          // collection is opportunistic and retryable by the next cleanup pass.
          reportError(error);
        }
      }, "exclusive");
    }
    if (thread.manifest.sourceViewId) await options.sourceViews?.release(thread.manifest.sourceViewId);
  };

  /**
   * D-242: delete the Thread's managed directory. The ownership assertion and
   * the user/writer guard still apply —a live writer blocks deletion rather
   * than losing its directory under a removed record. keep_worktree does not
   * apply to deletion: the Thread record is being removed, so a kept directory
   * would become an untracked allocation.
   */
  const deleteThreadDirectory = async (workspaceId: string, thread: Thread): Promise<void> => {
    if (!thread.worktree) return;
    if (!options.worktrees.reclaim) {
      throw new ThreadRuntimeError("unavailable", "Worktree reclamation is unavailable; the thread's managed directory cannot be removed safely");
    }
    const permission = options.canReclaimWorktree
      ? await options.canReclaimWorktree(workspaceId, thread.id, thread.worktree.path)
      : { safe: true };
    try {
      if (!permission.safe) {
        throw new ThreadRuntimeError("unavailable", permission.reason ?? "The worktree still has an active user or writer");
      }
      // nativeVerified skips the result-snapshot diff: the snapshot itself is
      // being released in the same cascade, so the directory is removed on the
      // strength of managed ownership alone.
      const result = await options.worktrees.reclaim(thread.worktree, { nativeVerified: true, workspaceId });
      if (!result.reclaimed) {
        throw new ThreadRuntimeError("unavailable", result.reason ?? "The managed directory could not be removed");
      }
    } finally {
      await permission.release?.();
    }
  };

  type DeletionPhase = "sessions" | "store" | "directory" | "registry";
  type DeletionNodeResult = {
    threadId: string;
    status: "complete" | "objects-pending" | "retryable" | "needs-attention";
    phase?: DeletionPhase;
    error?: string;
  };

  const deleteOneNode = async (
    workspaceId: string,
    parent: ThreadParent,
    threadId: string,
  ): Promise<DeletionNodeResult> => {
    const thread = await options.registry.getThread(workspaceId, parent, threadId);
    // Already removed —idempotent retry continues from observed facts (D-242 rework).
    if (!thread) return { threadId, status: "complete" };
    const deletion = thread.deletion;
    if (!deletion) {
      return { threadId, status: "needs-attention", phase: "sessions", error: "Thread has no durable deletion intent" };
    }
    const fail = async (
      status: Exclude<DeletionNodeResult["status"], "complete">,
      phase: DeletionPhase,
      error: unknown,
    ): Promise<DeletionNodeResult> => {
      const message = error instanceof Error ? error.message : String(error);
      await options.registry.setDeletionPhase(workspaceId, threadId, deletion.operationId, phase, message);
      return { threadId, status, phase, error: message };
    };
    if (thread.lifecycle !== "archived" || preparations.has(threadId) || sessionByThread.has(threadId)) {
      // Deletion must not mint a partial result revision that the cascade is
      // about to release; the Run still settles as cancelled first.
      await stopRunForArchive(workspaceId, parent, threadId, { capturePartial: false, reason: "deleted by user" });
    }
    // Phase 1: delete sessions. Idempotent —already-deleted sessions are
    // observed as empty by the registry, and the broker/deleteKnowledgeSession
    // tolerate re-deletion (D-242 rework).
    if (deletion.phase === "sessions") {
      try {
        await deleteThreadSessions(workspaceId, threadId);
        await options.registry.setDeletionPhase(workspaceId, threadId, deletion.operationId, "store");
      } catch (error) {
        return fail("retryable", "sessions", error);
      }
    }
    // Deletion is an explicit terminal operation. Stop independent experiment
    // processes after every persisted worker/session has been closed, before
    // any store/worktree/catalog cleanup; archive and Run settlement do not
    // call this hook.
    await options.stopExperimentsForThread?.(workspaceId, threadId);
    // Phase 2: release working-state objects. Idempotent —if the branch/draft
    // was already released, the store operations are no-ops on missing rows.
    if (deletion.phase === "sessions" || deletion.phase === "store") try {
      await options.releaseThreadEvidence?.(workspaceId, thread.id);
      await releaseThreadStore(workspaceId, thread);
      await options.registry.setDeletionPhase(workspaceId, threadId, deletion.operationId, "directory");
    } catch (error) {
      // Sessions are gone but objects remain —logically deleted, object
      // cleanup is retryable (D-242 rework).
      return fail("objects-pending", "store", error);
    }
    // Phase 3: delete the managed directory. Idempotent —if the directory was
    // already removed, reclaim reports it and we continue.
    if (deletion.phase !== "registry") try {
      await deleteThreadDirectory(workspaceId, thread);
      await options.registry.setDeletionPhase(workspaceId, threadId, deletion.operationId, "registry");
    } catch (error) {
      // Objects are released but the directory remains —retryable, but the
      // thread record is still intact for a retry (D-242 rework).
      return fail("retryable", "directory", error);
    }
    // Phase 4: remove the thread row from the catalog. This is the
    // irreversible commit point —after this, the thread is logically gone.
    try {
      await options.registry.removeThread(workspaceId, parent, threadId);
    } catch (error) {
      return fail("needs-attention", "registry", error);
    }
    return { threadId, status: "complete" };
  };

  const deleteUser = async (
    workspaceId: string,
    parent: ThreadParent,
    threadId: string,
  ) => {
    // Idempotent retry: if the thread is already gone, complete without
    // entering the cascade (D-242 rework). beginCascade would throw "Unknown
    // thread" for a missing target.
    const existing = await options.registry.getThread(workspaceId, parent, threadId);
    if (!existing) {
      return {
        workspaceId,
        parent,
        deletedThreadIds: [threadId],
        status: "complete" as const,
        nodeResults: [{ threadId, status: "complete" as const }],
        space: await inspectSpace(workspaceId, parent),
      };
    }
    // Same cascade shape as archive: abort preparations first, delete each
    // descendant on its own lifecycle turn in post-order, then the target.
    preparations.get(threadId)?.controller.abort();
    const releaseCascade = await beginCascade(workspaceId, threadId);
    try {
      const descendants = await collectDescendantsPostOrder(workspaceId, threadId);
      const operationId = existing.deletion?.operationId ?? `delete-${randomUUID()}`;
      const rootThreadId = existing.deletion?.rootThreadId ?? threadId;
      if (rootThreadId !== threadId) {
        throw new ThreadRuntimeError("conflict", `Thread deletion is already owned by ancestor ${rootThreadId}`);
      }
      await options.registry.markDeletionCascade(
        workspaceId,
        [...descendants.map((thread) => thread.id), threadId],
        threadId,
        operationId,
      );
      const nodeResults: DeletionNodeResult[] = [];
      for (const child of descendants) {
        preparations.get(child.id)?.controller.abort();
        await withThreadLifecycle(workspaceId, child.id, async () => {
          preparations.get(child.id)?.controller.abort();
          const result = await deleteOneNode(workspaceId, child.parent, child.id);
          nodeResults.push(result);
          return result;
        });
      }
      const childFailure = nodeResults.find((result) => result.status !== "complete");
      let targetResult: DeletionNodeResult;
      if (childFailure) {
        const root = await options.registry.getThread(workspaceId, parent, threadId);
        const phase = root?.deletion?.phase ?? "sessions";
        const error = `Descendant ${childFailure.threadId} is still pending at ${childFailure.phase ?? "unknown"}`;
        if (root?.deletion) {
          await options.registry.setDeletionPhase(workspaceId, threadId, root.deletion.operationId, phase, error);
        }
        targetResult = { threadId, status: "retryable", phase, error };
      } else {
        targetResult = await withThreadLifecycle(workspaceId, threadId, async () => {
            preparations.get(threadId)?.controller.abort();
            return deleteOneNode(workspaceId, parent, threadId);
          });
      }
      nodeResults.push(targetResult);
      // Aggregate status: complete only if every node completed; otherwise
      // the worst status wins (D-242 rework).
      const hasNeedsAttention = nodeResults.some((r) => r.status === "needs-attention");
      const hasRetryable = nodeResults.some((r) => r.status === "retryable");
      const hasObjectsPending = nodeResults.some((r) => r.status === "objects-pending");
      const aggregateStatus = hasNeedsAttention ? "needs-attention"
        : hasRetryable ? "retryable"
        : hasObjectsPending ? "objects-pending"
        : "complete";
      return {
        workspaceId,
        parent,
        deletedThreadIds: nodeResults.filter((result) => result.status === "complete").map((result) => result.threadId),
        status: aggregateStatus,
        nodeResults,
        space: await inspectSpace(workspaceId, parent),
      };
    } finally {
      releaseCascade();
    }
  };

  const resumePendingBaselineUpdates = async (): Promise<void> => {
    for (const workspaceId of await options.registry.listWorkspaceIds()) {
      for (const thread of await options.registry.listWorkspaceThreads(workspaceId)) {
        const pending = thread.worktree?.baselineUpdate;
        if (!pending || thread.deletion) continue;
        try {
          await updateBaseline(workspaceId, thread.parent, thread.id, pending.parentResultRevision);
        } catch (error) {
          await options.registry.setAttention(workspaceId, thread.id, "stalled").catch(reportError);
          reportError(error);
        }
      }
    }
  };

  const resumePendingDeletions = async (): Promise<void> => {
    // This is the existing one-shot startup recovery entry. Finish baseline
    // handoffs before deletion recovery can release their staging branches.
    await resumePendingBaselineUpdates();
    for (const pending of await options.registry.listDeletionRoots()) {
      try {
        await deleteUser(pending.scopeId, pending.parent, pending.threadId);
      } catch (error) {
        reportError(error);
      }
    }
  };

  const reopenRestoredSession = async (
    workspaceId: string,
    parent: ThreadParent,
    thread: Thread,
    signal?: AbortSignal,
  ): Promise<ThreadRun | null> => {
    if (thread.worktree?.baselineUpdate) {
      throw new ThreadRuntimeError("unavailable", `Finish baseline update ${thread.worktree.baselineUpdate.operationId} before restoring execution`);
    }
    const checkRestore = (): void => {
      if (signal?.aborted) throw new DOMException("Thread restore aborted", "AbortError");
    };
    const previous = await options.registry.getActiveRun(workspaceId, thread.id);
    const sessionId = thread.report?.transcriptRef.sessionId || previous?.sessionId || null;
    if (!sessionId) return null;
    const sourceRoot = await options.resolveWorkspaceRoot(workspaceId);
    const cwd = thread.worktree?.path ?? sourceRoot;
    const runtimeWorkspaceId = await options.resolveRuntimeWorkspaceId(cwd);
    let openedSessionId: string | null = null;
    try {
      checkRestore();
      const run = await options.registry.startRun(workspaceId, thread.id, previous?.runtimeId ?? "pi", { allowSettled: true });
      const frozen = run.frozen;
      if (!frozen) throw new ThreadRuntimeError("unavailable", "Restored Run has no frozen execution configuration");
      const opened = await options.sessions.open({
        modelSettings: frozen.modelSettings ?? null,
        cwd,
        ...(frozen.model ? { model: frozen.model } : {}),
        permissions: normalizeFrozenHarnessPermissions(frozen.permissions),
        ...(frozen.scope.length > 0 ? { scope: [...frozen.scope] } : {}),
        sessionId,
        tools: [...frozen.tools],
        workFocus: frozen.workFocus,
        workspaceId: runtimeWorkspaceId,
      });
      openedSessionId = opened.sessionId;
      checkRestore();
      const baselineStats = await options.sessions.stats(opened.sessionId).catch((error) => {
        reportError(error);
        return null;
      });
      const binding: RuntimeBinding = {
        scopeId: workspaceId,
        parent,
        threadId: thread.id,
        runId: run.id,
        sessionId: opened.sessionId,
        cwd,
        kind: thread.kind,
        providerId: frozen.model?.providerId ?? null,
        baseline: {
          cost: baselineStats?.cost ?? 0,
          toolCalls: baselineStats?.toolCalls ?? 0,
          tokens: {
            input: baselineStats?.tokens.input ?? 0,
            output: baselineStats?.tokens.output ?? 0,
            cacheRead: baselineStats?.tokens.cacheRead ?? 0,
          },
        },
      };
      bind(binding);
      await bindExecutionView({
        sessionId: opened.sessionId,
        scopeId: workspaceId,
        parent,
        threadId: thread.id,
        runId: run.id,
      });
      await options.registry.markRunRunning(workspaceId, thread.id, run.id, opened.sessionId);
      options.onThreadSessionBound?.(opened.sessionId, workspaceId);
      checkRestore();
      if (thread.kind === "implementation") scheduleStallTimer(binding);
      return run;
    } catch (error) {
      if (openedSessionId) {
        const bound = bindingsBySession.get(openedSessionId);
        if (signal?.aborted && bound) throw error;
        if (bound) {
          try {
            await closeBinding(bound, false);
          } catch (closeError) {
            throw new ThreadRuntimeError(
              "unavailable",
              `Thread session opened but could not be closed after restore failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
              { cause: error },
            );
          }
        } else {
          try {
            await options.sessions.close(openedSessionId);
          } catch (closeError) {
            throw new ThreadRuntimeError(
              "unavailable",
              `Thread session opened but could not be closed after restore failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
              { cause: error },
            );
          }
        }
      }
      throw error;
    }
  };

  const restoreUserImpl = async (workspaceId: string, parent: ThreadParent, threadId: string) => runPreparation(
    threadId,
    async (restoreSignal, setRestoreStage) => {
      const checkRestore = (): void => {
        if (restoreSignal.aborted) throw new DOMException("Thread restore aborted", "AbortError");
      };
      const existing = await options.registry.getThread(workspaceId, parent, threadId);
      if (!existing) throw new ThreadRuntimeError("not-found", `Thread not found: ${threadId}`);
      if (existing.deletion) throw new ThreadRuntimeError("conflict", "Thread deletion is pending");
      if (existing.worktree?.baselineUpdate) {
        throw new ThreadRuntimeError("unavailable", `Finish baseline update ${existing.worktree.baselineUpdate.operationId} before restoring execution`);
      }
      const blockedAncestor = await ancestorBlocksRestore(workspaceId, existing.parent);
      if (blockedAncestor) {
        throw new ThreadRuntimeError(
          "conflict",
          `Cannot restore thread ${threadId} while ancestor ${blockedAncestor} is archived or being archived`,
        );
      }
      const existingRun = await options.registry.getActiveRun(workspaceId, threadId);
      const existingSessionId = sessionByThread.get(threadId);
      const existingBinding = existingSessionId ? bindingsBySession.get(existingSessionId) : undefined;
      const directoryReady = !existing.worktree
        || isVirtualWorktree(existing.worktree)
        || (existing.worktree.materialized !== false && preparationStageOf(existing.worktree) === "ready");
      if (existingRun?.outcome === null
        && existingRun.workerState === "running"
        && existingBinding?.runId === existingRun.id
        && directoryReady) {
        return {
          ...await snapshotFor(workspaceId, parent, threadId),
          restoreStatus: "restored" as const,
          space: await inspectSpace(workspaceId, parent),
        };
      }
      if (existingRun?.outcome === null) {
        throw new ThreadRuntimeError("unavailable", "The current thread Run has not stopped and cannot be reopened safely");
      }
      if (existingSessionId && !existingBinding) {
        throw new ThreadRuntimeError("unavailable", "The previous thread session binding is unavailable to close safely");
      }
      if (existingBinding) await closeBinding(existingBinding, false);
      if (existing.lifecycle === "queued") {
        throw new ThreadRuntimeError("conflict", "A queued thread must finish its existing launch before it can be reopened");
      }
      const wasArchived = existing.lifecycle === "archived";
      let status: ThreadRestoreStatus = "restored";
      let message: string | undefined;
      let worktree = existing.worktree;
      const settings = await resolveEffectiveWorktreeSettings(workspaceId, parent);
      const worktreeStage = worktree ? preparationStageOf(worktree) : "ready";
      const needsMaterialize = Boolean(
        worktree
        && !isVirtualWorktree(worktree)
        && (worktree.materialized === false || worktreeStage === "materialize" || worktreeStage === "materializing"),
      );
      const needsSetupRetry = Boolean(
        worktree
        && worktree.materialized !== false
        && worktreeStage === "setup",
      );
      if (needsMaterialize || needsSetupRetry) {
        setRestoreStage("reclaiming-space");
        const sourceRoot = await options.resolveWorkspaceRoot(workspaceId);
        checkRestore();
        if (needsMaterialize && worktree) {
          let releaseReservation = async (): Promise<void> => undefined;
          try {
            if (preparationStageOf(worktree) === "materializing") {
              await clearIncompleteMaterialization(workspaceId, threadId, worktree);
            }
            const reservation = await reserveMaterialization(
              workspaceId,
              parent,
              threadId,
              settings,
              await estimateResultFootprint(workspaceId, existing, worktree, sourceRoot),
              true,
            );
            releaseReservation = reservation.release;
            checkRestore();
            if (reservation.failure) {
              status = "budget-unavailable";
              message = reservation.failure;
            } else {
              setRestoreStage("materializing-worktree");
              worktree = await materializeRecordedWorktree({
                scopeId: workspaceId,
                threadId,
                sourceRoot,
                worktree,
                ...(existing.workBranchId ? { branchId: existing.workBranchId } : {}),
                ...(existing.resultRevision ? { resultRevision: existing.resultRevision } : {}),
                setupRequired: Boolean(options.worktrees.runSetup && settings?.setup),
                signal: restoreSignal,
              });
              checkRestore();
            }
          } catch (error) {
            if (restoreSignal.aborted) throw error;
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "EEXIST") {
              status = "path-occupied";
              message = error instanceof Error ? error.message : "Original thread path is occupied by other content";
            } else if (isEnospc(error)) {
              status = "enospc";
              message = error instanceof Error ? error.message : "No space left on the volume";
            } else {
              status = "rebuild-failed";
              message = error instanceof Error ? error.message : String(error);
            }
          } finally {
            await releaseReservation();
          }
        }
        if (status === "restored" && worktree && options.worktrees.runSetup && settings?.setup) {
          setRestoreStage("running-setup");
          worktree.preparationStage = "setup";
          await persistWorktree(workspaceId, threadId, worktree);
          try {
            await options.worktrees.runSetup(sourceRoot, worktree, settings, restoreSignal);
            worktree.preparationStage = "ready";
            delete worktree.retentionReason;
          } catch (error) {
            worktree.preparationStage = "setup";
            if (restoreSignal.aborted) {
              worktree.retentionReason = "Directory restore was interrupted during setup";
              await persistWorktree(workspaceId, threadId, worktree).catch(reportError);
              throw error;
            }
            status = "rebuild-failed";
            message = `Directory restored but setup failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        if (status === "restored" && worktree && (!options.worktrees.runSetup || !settings?.setup)) {
          worktree.preparationStage = "ready";
          delete worktree.retentionReason;
        }
        if (worktree && status !== "restored" && message) worktree.retentionReason = message;
        if (worktree) await persistWorktree(workspaceId, threadId, worktree).catch(reportError);
      }

      let restored = existing;
      if (status === "restored") {
        checkRestore();
        if (wasArchived) {
          const value = await options.registry.restoreThread(workspaceId, threadId);
          if (!value) throw new ThreadRuntimeError("not-found", `Thread not found: ${threadId}`);
          restored = value;
        }
        try {
          const reopened = await reopenRestoredSession(workspaceId, parent, restored, restoreSignal);
          if (!reopened) throw new ThreadRuntimeError("unavailable", "The thread has no persisted Pi session to reopen");
        } catch (error) {
          if (restoreSignal.aborted) throw error;
          status = "rebuild-failed";
          message = `Thread session could not be reopened: ${error instanceof Error ? error.message : String(error)}`;
          const run = await options.registry.getActiveRun(workspaceId, threadId);
          if (run?.outcome === null) await options.registry.endRun(workspaceId, threadId, run.id, "failure", message).catch(reportError);
          if (wasArchived) await options.registry.archiveThread(workspaceId, threadId).catch(reportError);
          const failedThread = await options.registry.getThread(workspaceId, parent, threadId);
          if (failedThread?.worktree) {
            failedThread.worktree.retentionReason = message;
            await persistWorktree(workspaceId, threadId, failedThread.worktree).catch(reportError);
          }
        }
      }
      checkRestore();
      const thread = await options.registry.getThread(workspaceId, parent, threadId) ?? restored;
      const activeRun = await options.registry.getActiveRun(workspaceId, threadId);
      return {
        workspaceId,
        parent,
        thread,
        activeRun,
        restoreStatus: status,
        space: await inspectSpace(workspaceId, parent),
        ...(message ? { message } : {}),
      };
    },
  );

  const restoreUser = async (workspaceId: string, parent: ThreadParent, threadId: string) => (
    withThreadLifecycle(workspaceId, threadId, () => restoreUserImpl(workspaceId, parent, threadId))
  );

  const reclaimUserImpl = async (workspaceId: string, parent: ThreadParent, threadId: string) => {
    const thread = await options.registry.getThread(workspaceId, parent, threadId);
    if (!thread) throw new ThreadRuntimeError("not-found", `Thread not found: ${threadId}`);
    if (thread.deletion) throw new ThreadRuntimeError("conflict", "Thread deletion is pending");
    const result = await tryReclaimDirectory(workspaceId, parent, thread);
    return {
      ...await snapshotFor(workspaceId, parent, threadId),
      occupancy: result.occupancy,
      space: await inspectSpace(workspaceId, parent),
      reclaimed: result.reclaimed,
      ...(result.message ? { message: result.message } : {}),
    };
  };

  const reclaimUser = async (workspaceId: string, parent: ThreadParent, threadId: string) => (
    withThreadLifecycle(workspaceId, threadId, () => reclaimUserImpl(workspaceId, parent, threadId))
  );

  const historyThread = (snapshots: RetentionThreadSnapshot[], parent: ThreadParent, threadId: string): Thread => {
    const thread = snapshots.find((snapshot) => snapshot.thread.id === threadId)?.thread;
    if (!thread || thread.parent.kind !== parent.kind || thread.parent.id !== parent.id) {
      throw new ThreadRuntimeError("not-found", `Thread not found: ${threadId}`);
    }
    return thread;
  };

  const inspectResultHistory = (workspaceId: string, parent: ThreadParent, threadId: string): Promise<ThreadResultHistory> => (
    withThreadLifecycle(workspaceId, threadId, async () => {
      const initial = await options.registry.getThread(workspaceId, parent, threadId);
      if (!initial) throw new ThreadRuntimeError("not-found", `Thread not found: ${threadId}`);
      if (!initial.workBranchId) return { workspaceId, threadId, branchId: null, results: [] };
      if (!options.workingStates) throw new ThreadRuntimeError("unavailable", "Working-state storage is unavailable");
      try {
        return await options.workingStates.withBranchStore(workspaceId, "thread-history-inspect", async (store) => {
          const snapshots = await options.registry.listWorkspaceThreadSnapshots(workspaceId);
          return projectThreadResultHistory({ workspaceId, thread: historyThread(snapshots, parent, threadId), snapshots, store });
        }, "shared");
      } catch (error) {
        if (error instanceof ThreadRuntimeError) throw error;
        throw new ThreadRuntimeError("unavailable", error instanceof Error ? error.message : "Historical results cannot be read", { cause: error });
      }
    })
  );

  const releaseResultHistory = (
    workspaceId: string,
    parent: ThreadParent,
    threadId: string,
    input: ThreadResultHistoryReleaseParams,
  ): Promise<ThreadResultHistoryReleaseResult> => withThreadLifecycle(workspaceId, threadId, async () => {
    if (!input || typeof input.branchId !== "string" || !input.branchId.trim() || !Array.isArray(input.resultRevisions)
      || input.resultRevisions.some((revision) => !Number.isSafeInteger(revision) || revision < 1)) {
      throw new ThreadRuntimeError("invalid-request", "A branch identity and positive result revisions are required");
    }
    const initial = await options.registry.getThread(workspaceId, parent, threadId);
    if (!initial) throw new ThreadRuntimeError("not-found", `Thread not found: ${threadId}`);
    if (initial.deletion) throw new ThreadRuntimeError("conflict", "Thread deletion is pending");
    if (!options.workingStates) throw new ThreadRuntimeError("unavailable", "Working-state storage is unavailable");
    const requested = [...new Set(input.resultRevisions)];
    const result = await options.workingStates.withBranchStore(workspaceId, "thread-history-release", async (store): Promise<ThreadResultHistoryReleaseResult> => {
      // Lock order: this Thread's lifecycle, storage lease, Registry snapshot.
      // Release the Registry queue before collecting object files.
      const released = await options.registry.withThreadRetentionSnapshot(workspaceId, async (snapshots) => {
        const current = historyThread(snapshots, parent, threadId);
        if (current.workBranchId !== input.branchId) throw new ThreadRuntimeError("conflict", "The Thread's working branch changed; refresh its history");
        const history = await projectThreadResultHistory({ workspaceId, thread: current, snapshots, store });
        const blocked = history.results.filter((entry) => requested.includes(entry.resultRevision) && entry.protectedReasons.length > 0);
        if (blocked.length > 0) {
          throw new ThreadRuntimeError("conflict", `Selected versions are still in use: ${blocked.map((entry) => entry.resultRevision).join(", ")}`);
        }
        const present = new Set(history.results.map((entry) => entry.resultRevision));
        const expected = requested.filter((revision) => present.has(revision));
        const missingRevisions = requested.filter((revision) => !present.has(revision));
        try {
          return { releasedRevisions: await store.deleteResults(input.branchId, requested), missingRevisions };
        } catch (error) {
          // Metadata is the logical authority. If removal landed but cleanup
          // failed, report that observable state and keep all remaining refs.
          const observed = await Promise.all(expected.map((revision) => store.getResult(input.branchId, revision)));
          if (observed.some(Boolean)) throw error;
          reportError(error);
          return {
            releasedRevisions: expected, missingRevisions,
            failure: error instanceof Error ? error.message : "History cleanup did not finish",
          };
        }
      });
      if (released.failure) return {
        releasedRevisions: released.releasedRevisions, missingRevisions: released.missingRevisions,
        cleanup: { status: "failed", message: released.failure },
      };
      try {
        return { ...released, cleanup: { status: "complete", ...await store.collectUnreachableObjects() } };
      } catch (error) {
        reportError(error);
        return { ...released, cleanup: { status: "failed", message: error instanceof Error ? error.message : "Object cleanup did not finish" } };
      }
    }).catch((error: unknown) => {
      if (error instanceof ThreadRuntimeError) throw error;
      throw new ThreadRuntimeError("unavailable", error instanceof Error ? error.message : "Historical results cannot be released", { cause: error });
    });
    // A preview of a released version is no longer actionable. Completed
    // integration/undo records retain their independent safety/target objects.
    try {
      const thread = await options.registry.getThread(workspaceId, parent, threadId);
      const binding = thread?.integrationBinding;
      if (binding && requested.includes(binding.resultRevision)) {
        await options.registry.invalidateIntegrationBinding(workspaceId, threadId, binding.bindingFingerprint);
        (await options.resolveIntegrationCoordinator?.(workspaceId))?.invalidateThread?.(workspaceId, threadId);
      }
    } catch (error) { reportError(error); }
    return result;
  });

  const snapshotFor = async (workspaceId: string, parent: ThreadParent, threadId: string) => {
    const thread = await options.registry.getThread(workspaceId, parent, threadId);
    if (!thread) throw new ThreadRuntimeError("not-found", `Thread not found: ${threadId}`);
    return {
      workspaceId,
      parent,
      thread,
      activeRun: await options.registry.getActiveRun(workspaceId, threadId),
    };
  };

  const undoIntegration = async (
    workspaceId: string,
    parent: ThreadParent,
    threadId: string,
    input: { operationId: string; sourceOwner?: { ownerId: string; generation: number }; signal?: AbortSignal },
  ) => {
    let parentAuthority: IntegrationPlanInput["parentAuthority"];
    let parentWriteHeld = false;
    let releaseParentWrite = (): void => undefined;
    try {
      if (parent.kind === "thread") {
        const owner = await options.registry.getThreadById(workspaceId, parent.id);
        if (!owner) throw new Error(`Parent thread not found: ${parent.id}`);
        const parentRun = await options.registry.getActiveRun(workspaceId, parent.id);
        const parentSessionId = parentRun?.sessionId;
        if (owner.workBranchId && parentSessionId && options.virtualWriteGate && options.executionViews) {
          const ticket = await acquireVirtualWriteTicket(
            options.virtualWriteGate,
            parentSessionId,
            () => {
              const view = options.executionViews?.get(parentSessionId);
              return !!view && view.mode === "virtual";
            },
            input.signal,
          );
          parentWriteHeld = true;
          if (ticket !== "disk") releaseParentWrite = () => ticket.finish();
          const latest = await options.registry.getThreadById(workspaceId, parent.id);
          if (ticket !== "disk" && usesWorkingBranchAuthority(latest)) {
            parentAuthority = { kind: "branch", branchId: latest!.workBranchId!, sessionId: parentSessionId };
          } else if (latest?.worktree?.path && latest.worktree.materialized !== false && !isVirtualWorktree(latest.worktree)) {
            parentAuthority = {
              kind: "directory",
              directory: latest.worktree.path,
              workspaceId: await options.resolveRuntimeWorkspaceId(latest.worktree.path),
            };
          } else if (usesWorkingBranchAuthority(latest)) {
            parentAuthority = { kind: "branch", branchId: latest!.workBranchId!, sessionId: parentSessionId };
          } else {
            throw new Error(`Parent thread write authority is unavailable: ${parent.id}`);
          }
        } else if (usesWorkingBranchAuthority(owner)) {
          parentAuthority = {
            kind: "branch",
            branchId: owner.workBranchId!,
            ...(parentSessionId ? { sessionId: parentSessionId } : {}),
          };
        } else if (owner?.worktree?.path && owner.worktree.materialized !== false && !isVirtualWorktree(owner.worktree)) {
          parentAuthority = {
            kind: "directory",
            directory: owner.worktree.path,
            workspaceId: await options.resolveRuntimeWorkspaceId(owner.worktree.path),
          };
        } else {
          throw new Error(`Parent thread write authority is unavailable: ${parent.id}`);
        }
      }
      return await withThreadLifecycle(workspaceId, threadId, async () => {
        const thread = await options.registry.getThread(workspaceId, parent, threadId);
        if (!thread) throw new Error(`Thread not found: ${threadId}`);
        if (thread.deletion) throw new Error("Cannot undo integration while deletion is pending");
        if (thread.lifecycle === "archived") throw new Error("Cannot undo integration for an archived thread");
        const coordinator = options.resolveIntegrationCoordinator
          ? await options.resolveIntegrationCoordinator(workspaceId)
          : null;
        if (!coordinator) throw new Error("Thread integration coordinator is unavailable");
        const result = await coordinator.undoIntegration({
          workspaceId,
          threadId,
          operationId: input.operationId,
          ...(input.sourceOwner ? { sourceOwner: input.sourceOwner } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
          ...(parentAuthority ? { parentAuthority } : {}),
          ...(parentWriteHeld ? { parentWriteHeld: true } : {}),
        });
        const failed = result.status === "needs-attention";
        await options.registry.setIntegration(
          workspaceId,
          threadId,
          failed ? "conflict" : "dirty",
          thread.diffStats,
          undefined,
          failed ? undefined : null,
        );
        if (!failed) await options.registry.setIntegrationBinding(workspaceId, threadId, null);
        return result;
      });
    } finally {
      releaseParentWrite();
    }
  };

  const invalidateIntegrationPreviews = async (
    workspaceId: string,
    resourceIds?: readonly string[],
  ): Promise<void> => {
    const coordinator = options.resolveIntegrationCoordinator
      ? await options.resolveIntegrationCoordinator(workspaceId)
      : null;
    if (!coordinator) return;
    const invalidated = coordinator.invalidateWorkspace(workspaceId, resourceIds);
    await Promise.all(invalidated.map((preview) => options.registry.invalidateIntegrationBinding(
      workspaceId,
      preview.threadId,
      preview.bindingFingerprint,
    )));
  };

  const drain = async (): Promise<void> => {
    for (;;) {
      const pending = [
        ...eventTails.values(),
        ...backgroundTasks,
        ...[...preparations.values()].map((task) => task.promise),
        ...spaceMutationTails.values(),
        ...threadLifecycleTails.values(),
      ];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  };

  const materializeExecutionView = async (
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<WorkingBranchEnsureMaterializedResult> => {
    const view = options.executionViews?.get(sessionId);
    if (!view) return { status: "materialized", path: "" };
    if (view.mode === "materialized") {
      const current = await options.registry.getThreadForSession(view.workspaceId, sessionId);
      return { status: "materialized", path: current?.worktree?.path ?? "" };
    }
    if (!options.workingStates) {
      return { status: "failed", message: "Persistent working state is unavailable for materialization" };
    }
    const gate = options.virtualWriteGate;
    const switchRole = gate ? await gate.beginSwitch(sessionId) : "owner";
    if (switchRole === "already") {
      const latest = options.executionViews?.get(sessionId);
      if (latest?.mode === "materialized") {
        const current = await options.registry.getThreadForSession(latest.workspaceId, sessionId);
        return { status: "materialized", path: current?.worktree?.path ?? "" };
      }
      return { status: "failed", message: "Working-branch materialization did not complete" };
    }
    const switchSignal = mergeSignals(abortController.signal, signal);
    let releaseReservation = async (): Promise<void> => undefined;
    let keepSpawnReservation = false;
    let activeJournal: MaterializationSwitchJournal | undefined;
    let materializationPin: WorkingStatePin | undefined;
    let materializationStore: WorkingStateRootStore | undefined;
    let livePath = "";
    let callerAborted = false;
    const markCallerAbort = (): void => {
      callerAborted = true;
    };
    if (signal) {
      if (signal.aborted) callerAborted = true;
      else signal.addEventListener("abort", markCallerAbort, { once: true });
    }
    try {
      const latest = options.executionViews?.get(sessionId);
      if (!latest || latest.mode === "materialized") {
        const current = latest
          ? await options.registry.getThreadForSession(latest.workspaceId, sessionId)
          : null;
        return { status: "materialized", path: current?.worktree?.path ?? "" };
      }
      const thread = await options.registry.getThreadForSession(latest.workspaceId, sessionId);
      let worktree = thread?.worktree;
      if (!thread || !worktree?.path || !thread.workBranchId) {
        return { status: "failed", message: "Virtual run has no scratch directory to materialize" };
      }
      livePath = worktree.path;
      const sourceRoot = await options.resolveWorkspaceRoot(latest.workspaceId);
      const settings = await resolveEffectiveWorktreeSettings(latest.workspaceId, thread.parent);
      if (worktree.materializationHandoff) {
        const recovered = worktree.materializationHandoff;
        worktree = await resumeNativeMaterializationHandoff({
          scopeId: latest.workspaceId, threadId: latest.threadId, branchId: latest.branchId,
          sourceRoot, worktree, signal: switchSignal,
        });
        if (worktree.preparationStage === "setup" && options.worktrees.runSetup && settings?.setup) {
          await options.worktrees.runSetup(sourceRoot, worktree, settings, switchSignal);
          worktree.preparationStage = "ready";
          delete worktree.retentionReason;
          await persistWorktree(latest.workspaceId, latest.threadId, worktree);
        }
        if (worktree.preparationStage !== "ready") {
          throw new Error(`Recovered materialization is not ready: ${worktree.preparationStage ?? "unknown"}`);
        }
        options.executionViews?.bind({
          ...latest, revision: recovered.revision, writeRevision: recovered.writeRevision, mode: "materialized",
        });
        return { status: "materialized", path: worktree.path };
      }
      if (worktree.materializationSwitch) {
        const recoveredJournal = worktree.materializationSwitch;
        worktree = await recoverPersistedSwitch({
          scopeId: latest.workspaceId,
          threadId: latest.threadId,
          worktree,
          sourceRoot,
          signal: switchSignal,
          intent: callerAborted ? "abort" : "restart",
        });
        if (worktree.viewMode === "materialized") {
          options.executionViews?.bind({
            ...latest,
            revision: recoveredJournal.revision,
            writeRevision: recoveredJournal.writeRevision,
            mode: "materialized",
          });
          return { status: "materialized", path: worktree.path };
        }
      } else {
        await removeOrphanMaterializationDirs(worktree, ownershipAssertion(worktree));
      }
      switchSignal.throwIfAborted();
      const fixedMaterialization = await options.workingStates.withBranchStore(
                latest.workspaceId,
        "working-branch-materialize-estimate",
        async (store) => {
          const pin = await store.pinBranch(latest.branchId, { signal: switchSignal });
          try {
            return { store, pin, footprint: await store.measurePin(pin) };
          } catch (error) {
            await pin.release().catch(reportError);
            throw error;
          }
        },
        "shared",
      );
      materializationPin = fixedMaterialization.pin;
      materializationStore = fixedMaterialization.store;
      if (materializationPin.branchId !== latest.branchId
        || materializationPin.workspaceId !== latest.workspaceId
        || materializationPin.view !== "current") {
        throw new Error(`Kernel pinned the wrong working view for ${latest.branchId}`);
      }
      const footprint = fixedMaterialization.footprint;
      const pendingRelease = pendingMaterializeReservations.get(latest.threadId);
      if (pendingRelease) {
        const failure = await withSpaceMutation(latest.workspaceId, () => budgetFailureFor(
          latest.workspaceId,
          thread.parent,
          settings,
          footprint,
          latest.threadId,
        ));
        if (failure) {
          return { status: "failed", message: `Worktree budget unavailable: ${failure}` };
        }
        keepSpawnReservation = true;
        releaseReservation = async () => {
          pendingMaterializeReservations.delete(latest.threadId);
          await pendingRelease();
        };
      } else {
        const reservation = await reserveMaterialization(
          latest.workspaceId,
          thread.parent,
          latest.threadId,
          settings,
          footprint,
        );
        releaseReservation = reservation.release;
        if (reservation.failure) {
          return { status: "failed", message: `Worktree budget unavailable: ${reservation.failure}` };
        }
      }
      if (!materializationStore || !materializationPin) throw new Error(`Working branch ${latest.branchId} is unavailable`);
      const materializedRevision = materializationPin.revision;
      const materializedWriteRevision = materializationPin.writeRevision;
      let legacyJournal: MaterializationSwitchJournal | undefined;
      let nextWorktree: NonNullable<Thread["worktree"]>;
      if (materializationStore.materializePinManaged
        && materializationStore.pinBranchHandoff
        && materializationStore.openBranchHandoffPin
        && materializationStore.releaseBranchHandoffPin) {
        const handoff = {
          operationId: `working-live-materialize:${randomUUID()}`,
          pinId: `working-live-materialize-pin:${randomUUID()}`,
          revision: materializationPin.revision,
          writeRevision: materializationPin.writeRevision,
          root: materializationPin.root,
          view: "current" as const,
          nextPreparationStage: worktree.preparationStage === "setup" ? "setup" as const : "ready" as const,
          stage: "intent-persisted" as const,
        };
        worktree = {
          ...worktree,
          materialized: false,
          preparationStage: "materializing",
          materializationHandoff: handoff,
        };
        await persistWorktree(latest.workspaceId, latest.threadId, worktree);
        // Keep the estimation pin until the durable handoff has been opened or
        // created inside resume; the outer finally releases the estimation pin.
        nextWorktree = await resumeNativeMaterializationHandoff({
          scopeId: latest.workspaceId,
          threadId: latest.threadId,
          branchId: latest.branchId,
          sourceRoot,
          worktree,
          signal: switchSignal,
        });
        worktree = nextWorktree;
      } else {
        const token = randomUUID();
        const journal: MaterializationSwitchJournal = {
          revision: materializationPin.revision,
          writeRevision: materializationPin.writeRevision,
          root: materializationPin.root,
          stagingPath: `${worktree.path}.materializing-${token}`,
          backupPath: `${worktree.path}.virtual-backup-${token}`,
          stage: "staging-ready",
        };
        legacyJournal = journal;
        activeJournal = journal;
        await ownershipAssertion(worktree)("switch materialized worktree", [
          journal.stagingPath,
          journal.backupPath,
        ]);
        await fs.promises.rm(journal.stagingPath, { recursive: true, force: true });
        const materialized = await materializationStore.materializePin(materializationPin, journal.stagingPath);
        if (materialized.cow) cowByThread.set(latest.threadId, materialized.cow);
        switchSignal.throwIfAborted();
        await persistWorktree(latest.workspaceId, latest.threadId, { ...worktree, materializationSwitch: journal });
        switchSignal.throwIfAborted();
        await fs.promises.rm(journal.backupPath, { recursive: true, force: true });
        try {
          await fs.promises.rename(worktree.path, journal.backupPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        journal.stage = "live-backed-up";
        await persistWorktree(latest.workspaceId, latest.threadId, { ...worktree, materializationSwitch: { ...journal } });
        switchSignal.throwIfAborted();
        await fs.promises.rename(journal.stagingPath, worktree.path);
        journal.stage = "staging-promoted";
        await persistWorktree(latest.workspaceId, latest.threadId, { ...worktree, materializationSwitch: { ...journal } });
        switchSignal.throwIfAborted();
        let executionBaseline = worktree.executionBaseline;
        if (options.worktrees.attachIsolatedGitContext) {
          const attached = await options.worktrees.attachIsolatedGitContext(sourceRoot, worktree, switchSignal);
          if (attached.executionBaseline) executionBaseline = attached.executionBaseline;
        }
        switchSignal.throwIfAborted();
        nextWorktree = {
          ...clearSwitchJournal(worktree),
          viewMode: "materialized" as const,
          materialized: true,
          preparationStage: worktree.preparationStage === "setup" ? "setup" as const : "ready" as const,
          ...(executionBaseline ? { executionBaseline } : {}),
        };
        if (!executionBaseline) delete nextWorktree.executionBaseline;
        delete nextWorktree.materializationFingerprint;
        await persistWorktree(latest.workspaceId, latest.threadId, nextWorktree);
        activeJournal = undefined;
      }
      options.executionViews?.bind({
        ...latest,
        revision: materializedRevision,
        writeRevision: materializedWriteRevision,
        mode: "materialized",
      });
      if (legacyJournal) {
        await fs.promises.rm(legacyJournal.backupPath, { recursive: true, force: true });
        await removeOrphanMaterializationDirs(worktree, ownershipAssertion(worktree));
      }
      keepSpawnReservation = false;
      if (nextWorktree.preparationStage === "setup" && options.worktrees.runSetup && settings?.setup) {
        try {
          switchSignal.throwIfAborted();
          await options.worktrees.runSetup(sourceRoot, nextWorktree, settings, switchSignal);
          nextWorktree.preparationStage = "ready";
          delete nextWorktree.retentionReason;
          await persistWorktree(latest.workspaceId, latest.threadId, nextWorktree);
        } catch (setupErr) {
          const message = setupErr instanceof Error ? setupErr.message : String(setupErr);
          nextWorktree.retentionReason = message;
          await persistWorktree(latest.workspaceId, latest.threadId, nextWorktree).catch(reportError);
          return { status: "failed", message };
        }
      }
      return { status: "materialized", path: worktree.path };
    } catch (error) {
      if (activeJournal && livePath) {
        const currentView = options.executionViews?.get(sessionId);
        const currentThread = currentView
          ? await options.registry.getThreadForSession(currentView.workspaceId, sessionId).catch(() => null)
          : null;
        if (currentThread?.worktree) {
          await rollbackMaterializationSwitch(
            currentThread.worktree,
            activeJournal,
            ownershipAssertion(currentThread.worktree),
          ).catch(reportError);
        }
        const latest = options.executionViews?.get(sessionId);
        if (latest) {
          const current = await options.registry.getThreadForSession(latest.workspaceId, sessionId).catch(() => null);
          if (current?.worktree) {
            await persistWorktree(latest.workspaceId, latest.threadId, clearSwitchJournal(current.worktree)).catch(reportError);
          }
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      const aborted = callerAborted || switchSignal.aborted;
      return {
        status: "failed",
        message: aborted ? `Working-branch materialization was cancelled: ${message}` : message,
      };
    } finally {
      await materializationPin?.release().catch(reportError);
      if (signal) signal.removeEventListener("abort", markCallerAbort);
      gate?.endSwitch(sessionId);
      if (!keepSpawnReservation) await releaseReservation();
    }
  };

  const isThreadSession = (sessionId: string): boolean => bindingsBySession.has(sessionId);

  const getSessionBinding = (sessionId: string): { scopeId: string; parent: ThreadParent; threadId: string } | null => {
    const binding = bindingsBySession.get(sessionId);
    return binding
      ? { scopeId: binding.scopeId, parent: binding.parent, threadId: binding.threadId }
      : null;
  };

  const resolveSessionBinding = async (sessionId: string): Promise<{
    scopeId: string;
    parent: ThreadParent;
    threadId: string;
  } | null> => {
    const live = getSessionBinding(sessionId);
    if (live) return live;
    const persisted = await options.registry.getSessionBinding(sessionId);
    return persisted
      ? { scopeId: persisted.owningScopeId, parent: persisted.parent, threadId: persisted.threadId }
      : null;
  };

  const dispose = async (): Promise<void> => {
    abortController.abort();
    for (const preparation of preparations.values()) preparation.controller.abort();
    await drain();
    bindingsBySession.clear();
    sessionByThread.clear();
    lastAgentEnd.clear();
    autoResumedThreads.clear();
    terminatingSessions.clear();
    recentToolSignatures.clear();
    for (const timer of stallTimers.values()) clearTimeout(timer);
    stallTimers.clear();
    stalledThreads.clear();
    waitingSessions.clear();
    preparations.clear();
    spaceMutationTails.clear();
    for (const threadId of [...pendingMaterializeReservations.keys()]) {
      await releasePendingMaterializeReservation(threadId);
    }
    spaceReservations.clear();
    threadLifecycleTails.clear();
  };

  /** Pi owns the active context, including kept entries before a compaction record. */
  const captureInputContext = async (
    sessionId: string,
  ): Promise<Pick<import("@varin/protocol").ThreadInheritedContext, "text" | "anchors" | "images"> | null> => {
    if (!options.sessions.captureInput) {
      throw new ThreadRuntimeError("unavailable", "The session adapter cannot capture committed Pi input");
    }
    return options.sessions.captureInput(sessionId);
  };

  /**
   * Starts a new Run on a settled implementation Thread (D-285.4):
   * `continue` resumes the retained session with the new task verbatim;
   * `fresh` opens a new session on a rebuilt input assembled from the task,
   * still-valid requirements, delivered results, unresolved items, and
   * historical anchors. The old transcript and work are never discarded.
   */
  const continueRun = async (input: {
    scopeId: string;
    parent: ThreadParent;
    threadId: string;
    mode: "continue" | "fresh";
    task: string;
    requestId?: string;
    /** Host-only restoration of a discussion worker interrupted by Bot sleep. */
    resumeSuspended?: boolean;
    /** Skips the shared-budget admission check (dequeue path already gated). */
    admitted?: boolean;
    from?: import("@varin/protocol").ThreadMessagePeer;
    /**
     * Resolved capability/model re-route for the new Run (7B/D-300). Frozen
     * at request time; a parked continuation keeps this exact configuration.
     */
    frozen?: import("@varin/protocol").ThreadRunFrozenConfig;
  }): Promise<{ runId?: string }> => {
    if (!await options.registry.canExecuteScope(input.scopeId)) throw new ThreadRuntimeError("unavailable", "Bot is asleep");
    const requestId = input.requestId ?? `continuation-${randomUUID()}`;
    const from = input.from ?? { kind: "user" as const, id: "host" };
    const thread = await options.registry.getThread(input.scopeId, input.parent, input.threadId);
    if (!thread) throw new ThreadRuntimeError("not-found", `Thread not found: ${input.threadId}`);
    const priorRun = (await options.registry.listRuns(input.scopeId, input.threadId))
      .find((run) => run.request?.requestId === requestId);
    const priorPending = thread.pendingContinuations?.find((request) => request.requestId === requestId);
    const priorIntent = priorRun?.request ?? priorPending;
    // A worktree policy change cannot reuse the retained Pi session's cwd.
    // Promote the request to the existing fresh-input path so the new Run is
    // prepared in the frozen directory while retaining the old context.
    const effectiveMode = input.mode === "continue" && priorIntent?.mode === "fresh"
      ? "fresh" as const
      : input.frozen && input.frozen.worktree !== thread.manifest.worktree
        ? "fresh" as const
        : input.mode;
    const effectiveFrozen = input.frozen
      ? { ...structuredClone(input.frozen), inputOrigin: effectiveMode }
      : undefined;
    input = {
      ...input,
      mode: effectiveMode,
      ...(effectiveFrozen ? { frozen: effectiveFrozen } : {}),
    };
    if (priorRun) {
      if (priorRun.request!.task !== input.task || priorRun.request!.mode !== input.mode
        || priorRun.request!.from.kind !== from.kind || priorRun.request!.from.id !== from.id
        || !sameFrozenRunConfig(priorRun.request!.frozen, input.frozen)) {
        throw new ThreadRuntimeError("invalid-request", "Continuation identity is already bound to different input");
      }
      if (priorRun.outcome === "failure" || priorRun.outcome === "cancelled") {
        throw new ThreadRuntimeError("unavailable", priorRun.exitReason ?? "The recorded execution attempt failed");
      }
      return { runId: priorRun.id };
    }
    if (thread.kind !== "implementation" && !input.resumeSuspended) {
      throw new ThreadRuntimeError("invalid-request", "Execution requests apply to implementation threads");
    }
    if (thread.worktree?.baselineUpdate) throw new ThreadRuntimeError("unavailable", `Finish baseline update ${thread.worktree.baselineUpdate.operationId} before continuing execution`);
    const previous = await options.registry.getActiveRun(input.scopeId, thread.id);
    const resumable = thread.lifecycle === "settled"
      || (thread.lifecycle === "active" && (previous?.outcome === "lost" || previous?.workerState === "lost"));
    if (!resumable) {
      throw new ThreadRuntimeError("conflict", `Thread cannot continue from lifecycle ${thread.lifecycle}: ${input.threadId}`);
    }
    // Requests share the root execution budget (3.18C): a full pool parks the
    // continuation on the Thread; the dequeue path promotes it when a slot frees.
    const park = async (): Promise<void> => {
      await options.registry.enqueueContinuation(input.scopeId, thread.id, {
        mode: input.mode,
        task: input.task,
        requestId,
        from,
        ...(input.frozen ? { frozen: input.frozen } : {}),
        at: new Date().toISOString(),
      });
    };
    if (thread.kind === 'implementation' && !input.admitted && await options.registry.countActiveInRoot(input.scopeId, input.parent) >= thread.manifest.concurrency) {
      await park();
      return {};
    }
    const retainedSessionId = thread.report?.transcriptRef.sessionId ?? previous?.sessionId ?? null;
    let freshInput: ReturnType<typeof assembleFreshInput> | undefined;
    if (input.mode === "fresh") {
      let entries: SessionEntriesResult["entries"] = [];
      if (retainedSessionId && options.sessions.readEntries) {
        entries = (await options.sessions.readEntries(retainedSessionId, undefined, "branch")).entries;
      } else if (retainedSessionId) {
        entries = (await options.sessions.entries(retainedSessionId, "branch")).entries;
      }
      const sourceRun = (await options.registry.listRuns(input.scopeId, thread.id))
        .findLast((candidate) => candidate.sessionId === retainedSessionId);
      const mined = minePiBranchEntries(entries);
      const results: string[] = [
        "The current system and project rules are loaded by this new Pi session; do not treat old transcript rules or verification as current authority.",
        ...(thread.workBranchId ? [`working branch: ${thread.workBranchId}${thread.resultRevision ? ` (selected published result r${thread.resultRevision})` : ""}; existing code delta is retained`] : []),
      ];
      if (thread.report) {
        if (thread.report.conclusion) results.push(`conclusion: ${thread.report.conclusion}`);
        if (thread.report.changedFiles.length > 0) {
          results.push(`changed files: ${thread.report.changedFiles.join(", ")}`);
        }
        if (thread.report.deviations.length > 0) {
          results.push(`deviations: ${thread.report.deviations.join("; ")}`);
        }
        if (retainedSessionId) results.push(`transcript: session ${retainedSessionId}`);
      }
      freshInput = assembleFreshInput({
        task: input.task,
        goal: thread.brief,
        ...(sourceRun ? { sourceRunId: sourceRun.id } : {}),
        results,
        openItems: thread.report?.unresolved ?? [],
        carriedUserMessages: mined.carriedUserMessages,
        boundaryEntryIds: mined.boundaryEntryIds,
      });
    }
    // Assembly failures leave the old Run/result/active history authoritative.
    let run: ThreadRun;
    try {
      const admitted = await options.registry.admitRun(input.scopeId, thread.id, previous?.runtimeId ?? "pi", {
        allowSettled: true,
        inputOrigin: input.mode,
        request: { requestId, mode: input.mode, task: input.task, from, at: new Date().toISOString(),
          ...(input.frozen ? { frozen: input.frozen } : {}),
          ...(freshInput ? { preparedInput: freshInput.text } : {}) },
        ...(input.frozen ? { frozen: input.frozen } : {}),
      });
      if (!admitted.started) return { runId: admitted.run.id };
      run = admitted.run;
    } catch (error) {
      if (!(error instanceof ThreadAdmissionError)) throw error;
      // Dequeue observations are not reservations either. A competing Run
      // may have claimed the slot; preserve both the request and held input.
      await park();
      return {};
    }
    try {
      const frozen = run.frozen;
      if (!frozen) throw new ThreadRuntimeError("unavailable", "Continuation has no frozen Run configuration");
      // Once admitted, every preparation failure must end this Run and free
      // its slot, including a failed message-catalog read.
      const pending = input.mode === "continue"
        ? await options.registry.listPendingThreadMessages(input.scopeId, thread.id, input.requestId)
        : []; // fresh spawn owns pending delivery; never embed the same messages twice
      const task = pending.length > 0
        ? `${input.task}\n\nMessages delivered while waiting for this run:\n${pendingMessagesSection(pending)}`
        : input.task;
      if (input.mode === "continue") {
        if (!retainedSessionId) {
          throw new ThreadRuntimeError("unavailable", "No retained session to continue; request with context \"fresh\"");
        }
        const sourceRoot = await options.resolveWorkspaceRoot(input.scopeId);
        const cwd = thread.worktree?.path ?? sourceRoot;
        const runtimeWorkspaceId = await options.resolveRuntimeWorkspaceId(cwd);
        const snapshot = await options.sessions.open({
          modelSettings: frozen.modelSettings ?? null,
          cwd,
          ...(frozen.model ? { model: frozen.model } : {}),
          permissions: normalizeFrozenHarnessPermissions(frozen.permissions),
          ...(frozen.scope.length > 0 ? { scope: [...frozen.scope] } : {}),
          sessionId: retainedSessionId,
          tools: [...frozen.tools],
          workFocus: frozen.workFocus,
          workspaceId: runtimeWorkspaceId,
        });
        const baselineStats = await options.sessions.stats(snapshot.sessionId).catch((error) => {
          reportError(error);
          return null;
        });
        const binding = {
          scopeId: input.scopeId,
          parent: input.parent,
          threadId: thread.id,
          runId: run.id,
          sessionId: snapshot.sessionId,
          cwd,
          kind: thread.kind,
          providerId: frozen.model?.providerId ?? null,
          baseline: {
            cost: baselineStats?.cost ?? 0,
            toolCalls: baselineStats?.toolCalls ?? 0,
            tokens: {
              input: baselineStats?.tokens.input ?? 0,
              output: baselineStats?.tokens.output ?? 0,
              cacheRead: baselineStats?.tokens.cacheRead ?? 0,
            },
          },
        };
        bind(binding);
        await bindExecutionView({
          sessionId: snapshot.sessionId,
          scopeId: input.scopeId,
          parent: input.parent,
          threadId: thread.id,
          runId: run.id,
        });
        await options.registry.markRunRunning(input.scopeId, thread.id, run.id, snapshot.sessionId);
        options.onThreadSessionBound?.(snapshot.sessionId, input.scopeId);
        scheduleStallTimer(binding);
        await options.sessions.prompt(snapshot.sessionId, task);
        await options.registry.acknowledgeThreadMessages(input.scopeId, thread.id, pending.map((message) => message.id), run.id);
        return { runId: run.id };
      }
      await spawn({
        scopeId: input.scopeId,
        parent: input.parent,
        threadId: thread.id,
        runId: run.id,
        brief: thread.brief,
        ...(thread.preset ? { preset: thread.preset } : {}),
        kind: thread.kind,
        createdBy: thread.createdBy,
        carryBlocks: thread.manifest.carryBlocks,
        concurrency: thread.manifest.concurrency,
        ...(thread.manifest.draftBaselineId ? { draftBaselineId: thread.manifest.draftBaselineId } : {}),
        ...(thread.manifest.sourceViewId ? { sourceViewId: thread.manifest.sourceViewId } : {}),
        autoRun: true,
        worktree: frozen.worktree,
        ...(frozen.model ? { model: frozen.model } : {}),
        tools: [...frozen.tools],
        permissions: normalizeFrozenHarnessPermissions(frozen.permissions),
        ...(frozen.scope.length > 0 ? { scope: [...frozen.scope] } : {}),
        ...(frozen.systemPromptFragment ? { systemPromptFragment: frozen.systemPromptFragment } : {}),
        promptText: freshInput!.text,
      });
      return { runId: run.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedSession = sessionByThread.get(thread.id);
      const failedBinding = failedSession ? bindingsBySession.get(failedSession) : undefined;
      if (failedBinding?.runId === run.id) await closeBinding(failedBinding, true).catch(reportError);
      await options.registry.failRunRequest(input.scopeId, thread.id, run.id, message);
      await options.registry.endRun(input.scopeId, thread.id, run.id, "failure", message).catch(reportError);
      throw error;
    }
  };

  return {
    suspendForBot,
    spawn,
    captureInputContext,
    continueRun,
    captureDraftBaseline,
    prepareIsolatedBranch,
    createDiscussion,
    convertDiscussion,
    rootScopeForSession,
    scopeForSession,
    processEvent,
    resumeLostForParent,
    send,
    kill,
    merge,
    updateBaseline,
    previewIntegration,
    undoIntegration,
    invalidateIntegrationPreviews,
    archiveUser,
    deleteUser,
    resumePendingDeletions,
    restoreUser,
    inspectSpace,
    reclaimUser,
    inspectResultHistory,
    releaseResultHistory,
    drain,
    isThreadSession,
    getSessionBinding,
    resolveSessionBinding,
    materializeExecutionView,
    beginCascade,
    dispose,
  };
}

export type ThreadRuntime = ReturnType<typeof createThreadRuntime>;
