/**
 * Thread protocol types — shared between Host events and harness services.
 *
 * A Thread is durable work. A ThreadRun is one execution attempt. Keeping
 * those records separate prevents a restarted worker from rewriting history
 * as though the first attempt never ended.
 */

import type { PermissionPolicy } from "./permission-gate.js";
import type { WorkFocusId } from "./work-focus.js";
import type { ResearchCapability, ResearchResourceManifest, ThreadResearchManifest } from "./research-capabilities.js";

export type ThreadKind = "discussion" | "implementation";
export type ThreadPurpose = "task" | "agent-root" | "research-root" | "bot-root";
/** Root threads bound to a user's real session via `attached-root` runs. */
export const isAttachedRootPurpose = (purpose: ThreadPurpose | undefined | null): boolean => (
  purpose === "agent-root" || purpose === "research-root" || purpose === "bot-root"
);
export type ThreadSessionOwner = "spawned-child" | "attached-root";
export type ThreadCreatedBy = "user" | "agent";
export type ThreadLifecycle = "preparing" | "queued" | "active" | "settled" | "archived";
export type ThreadAttention = "none" | "user" | "permission" | "thread" | "experiment" | "followup" | "stalled" | "looping";
export type ThreadIntegration = "none" | "dirty" | "merge-ready" | "conflict" | "merged";
export type ThreadRunWorkerState = "starting" | "running" | "lost" | "exited";
export type ThreadRunOutcome = "success" | "failure" | "cancelled" | "lost";
export type ThreadDeletionPhase = "sessions" | "store" | "directory" | "registry";

/** Durable user intent for whole-Thread deletion. The phase is the next step. */
export interface ThreadDeletionState {
  operationId: string;
  rootThreadId: string;
  phase: ThreadDeletionPhase;
  requestedAt: string;
  updatedAt: string;
  error?: string;
}

export type ThreadParent =
  | { kind: "session"; id: string }
  | { kind: "thread"; id: string };

/**
 * Host-owned mapping from a live Pi session to the Thread catalog it belongs to.
 * `owningScopeId` is the durable owner scope (project workspace id or
 * `session:<id>`); it is not the scratch or materialized execution workspace
 * Documents assigns to the Run cwd.
 */
export interface ThreadSessionBinding {
  sessionId: string;
  /**
   * Durable owner scope of the Thread/Run this session executes: a project
   * workspace id, or `session:<sessionId>` for session-owned work (HR0).
   * Resolution must never require a directory to exist.
   */
  owningScopeId: string;
  threadId: string;
  runId: string;
  parent: ThreadParent;
  owner: ThreadSessionOwner;
}

export type RetrievalFactStatus = "source-checked" | "unknown" | "unavailable";
export type RetrievalSourceCheck = "source-valid" | "unavailable" | "unknown";
export type RetrievalEvidenceCompletion =
  | "delivered"
  | "incomplete"
  | "cancelled"
  | "unavailable";

export interface RetrievalOutputRef {
  durability: "ephemeral";
  generation: string;
  handle: string;
}

export interface RetrievalArtifactRef {
  durability: "durable";
  hash: string;
  byteLength: number;
  /** Exact durable record that authorizes this content read. */
  recordId: string;
  recordType: "retrieval.artifact" | "retrieval.receipt";
  workspaceId: string;
  sessionId?: string;
  threadId?: string;
  runId?: string;
}

export interface RetrievalReceiptAuthority {
  owningWorkspaceId: string;
  sessionId: string;
  threadId?: string;
  runId?: string;
}

export interface RetrievalUrlReceipt {
  receiptId: string;
  finalUrl: string;
  contentHash: string;
  revision: string;
  /** Durable bytes fetched for this exact receipt. */
  artifact: RetrievalArtifactRef;
  /** The actor that may promote this temporary receipt into retrieval evidence. */
  authority: RetrievalReceiptAuthority;
}

export interface RetrievalFactSource {
  kind: "local" | "url" | "output";
  check?: RetrievalSourceCheck;
  path?: string;
  startLine?: number;
  endLine?: number;
  revision?: string;
  origin?: "disk" | "surface-draft" | "working-branch";
  contentHash?: string;
  excerpt?: string;
  artifact?: RetrievalArtifactRef;
  url?: string;
  receiptId?: string;
  outputRef?: RetrievalOutputRef;
}

export interface RetrievalFact {
  claim: string;
  status: RetrievalFactStatus;
  sources: RetrievalFactSource[];
}

export interface RetrievalAttempt {
  action: string;
  outcome: "rejected" | "unavailable" | "empty" | "failed";
  detail?: string;
}

/**
 * Host-validated retrieval delivery. Host can prove source-checked /
 * source-valid identity, not that a claim is semantically true. There are
 * no recommendation or priority fields.
 */
export interface RetrievalEvidence {
  question: string;
  scope: string[];
  facts: RetrievalFact[];
  unknowns: string[];
  attempted: RetrievalAttempt[];
  completion: RetrievalEvidenceCompletion;
}

export interface ThreadReport {
  /** Natural-language assistant report, independent of optional structured evidence. */
  conclusion: string;
  changedFiles: string[];
  unresolved: string[];
  deviations: string[];
  confidence: number;
  transcriptRef: TranscriptRef;
  blocksSnapshot: Record<string, string>;
  resultCommit?: string;
  /** Native immutable working-state revision read by inspect/merge/reopen. */
  resultRevision?: number;
  /** Optional structured retrieval evidence sealed by the Host; prose is never source-checked. */
  evidence?: RetrievalEvidence;
  /** Run that sealed `evidence`; stable across later Run attempts. */
  evidenceRunId?: string;
}

export const emptyRetrievalEvidence = (
  question: string,
  scope: readonly string[],
  completion: RetrievalEvidenceCompletion = "incomplete",
): RetrievalEvidence => ({
  question,
  scope: [...scope],
  facts: [],
  unknowns: [],
  attempted: [],
  completion,
});

export const summarizeRetrievalEvidence = (evidence: RetrievalEvidence): string => {
  const checked = evidence.facts.filter((fact) => fact.status === "source-checked").length;
  return `retrieval ${evidence.completion}: ${checked} source-checked, ${evidence.unknowns.length} unknown, ${evidence.attempted.length} attempted`;
};

export const formatRetrievalEvidenceText = (evidence: RetrievalEvidence): string => {
  const lines = [
    `Question: ${evidence.question}`,
    `Scope: ${evidence.scope.join(", ") || "(workspace)"}`,
    `Completion: ${evidence.completion}`,
    `Facts (${evidence.facts.length}):`,
  ];
  for (const fact of evidence.facts) {
    lines.push(`- [${fact.status}] ${fact.claim}`);
    for (const source of fact.sources) {
      if (source.kind === "local") {
        const range = source.startLine !== undefined && source.endLine !== undefined
          ? `:${source.startLine}-${source.endLine}`
          : "";
        const revision = source.revision ? ` @${source.revision}` : "";
        const origin = source.origin ? ` (${source.origin})` : "";
        const check = source.check ? ` ${source.check}` : "";
        lines.push(`  ${source.path ?? "?"}${range}${revision}${origin}${check}`);
        if (source.excerpt) {
          for (const line of source.excerpt.split("\n")) lines.push(`    ${line}`);
        }
        continue;
      }
      if (source.kind === "url") {
        const receipt = source.receiptId ? ` receipt ${source.receiptId}` : "";
        lines.push(`  ${source.url ?? "?"}${receipt}`);
        continue;
      }
      if (source.artifact) {
        lines.push(`  output artifact ${source.artifact.hash}`);
        continue;
      }
      lines.push(`  output ${source.outputRef?.handle ?? "?"}`);
    }
  }
  if (evidence.unknowns.length > 0) {
    lines.push("Unknowns:");
    for (const item of evidence.unknowns) lines.push(`- ${item}`);
  }
  if (evidence.attempted.length > 0) {
    lines.push("Attempted:");
    for (const item of evidence.attempted) {
      lines.push(`- ${item.action}: ${item.outcome}${item.detail ? ` (${item.detail})` : ""}`);
    }
  }
  return lines.join("\n");
};

export const sealRetrievalEvidence = (
  pending: RetrievalEvidence | undefined,
  input: {
    brief: string;
    outcome: ThreadRunOutcome;
  },
): RetrievalEvidence | undefined => {
  if (!pending) return undefined;
  const base = {
    question: input.brief,
    scope: [...pending.scope],
    facts: pending.facts.map((fact) => ({
      ...fact,
      sources: fact.sources.map((source) => {
        if (!source.outputRef) return source;
        const { outputRef: _ephemeral, ...rest } = source;
        return rest;
      }),
    })),
    unknowns: [...pending.unknowns],
    attempted: [...pending.attempted],
    completion: pending.completion,
  };
  if (input.outcome === "cancelled") {
    return { ...base, question: input.brief, completion: "cancelled" };
  }
  const unavailableOnly = pending.facts.length > 0
    && pending.facts.every((fact) => fact.status === "unavailable");
  if (unavailableOnly) return { ...base, question: input.brief, completion: "unavailable" };
  return {
    ...base,
    question: input.brief,
    completion: input.outcome === "success" ? "delivered" : "incomplete",
  };
};

export interface TranscriptRef {
  runtimeId: string;
  sessionId: string;
  /** Null means the first entry on the referenced branch. */
  fromEntryId: string | null;
  /** Null means the current/referenced branch leaf. */
  toEntryId: string | null;
  branchLeafId?: string;
}

export interface ThreadWaitingFor {
  kind: "user" | "permission" | "thread" | "experiment" | "followup";
  text: string;
  /** An idle discussion can accept another message; no answer is required. */
  reason?: "discussion-ready";
}

export interface ThreadDependencyWait {
  id: string;
  runId: string;
  sessionId: string;
  deadline?: number;
  state: "watching" | "ready" | "resuming";
  targets: Array<{ id: string; runId: string | null; resultRevision: number | null;
    lifecycle: ThreadLifecycle; attention: ThreadAttention; integration: ThreadIntegration; outcome: ThreadRunOutcome | null;
    codeSubmissionStates?: Record<string, string> }>;
  requestIds: string[];
  /** A correlated reply wait; other messages/results do not satisfy it. */
  replyTo?: string;
  replyOutcome?: "elapsed" | "interrupted";
  reason?: string;
  error?: string;
}

export interface ThreadBaselineUpdate {
  operationId: string;
  /** Kernel-owned staging branch; holds the selected parent base and planned result. */
  stageBranchId: string;
  parentBranchId: string;
  parentResultRevision: number;
  expectedWriteRevision: number;
  originalRoot: string;
  originalBaseRoot: string;
  plannedRoot: string;
  phase: "prepared" | "committed";
  updatedFromParent: string[];
  keptChildPaths: string[];
  mergedPaths: string[];
  conflicts: { path: string; reason?: string }[];
}

export interface ThreadWorktree {
  path: string;
  /** Durable directory-apply/branch-CAS handoff. Never discarded on ambiguous failure. */
  baselineUpdate?: ThreadBaselineUpdate;
  /**
   * Varin-managed directory that owns `path` and every switch/snapshot
   * sibling. Destructive and Git-mutating operations reject records without
   * this persistent ownership root or whose canonical path escapes it.
   */
  managedRoot?: string;
  /** Retrieval input view; may be materialized for LSP but is never publishable. */
  readOnlyInput?: boolean;
  /**
   * Parent-state identity (parent HEAD or `thread-<id>@<writeRevision>`).
   * Inspect/snapshot/settle must not treat this as a commit that the
   * execution repository can resolve.
   */
  base: string;
  /**
   * Commit currently resolvable in the execution Git repository after
   * `git init`, detached worktree add, rematerialize, or crash recovery.
   * Cleared when the execution directory is reclaimed.
   */
  executionBaseline?: string;
  /** Internal branch that retains the baseline and, after settlement, the result. */
  branch?: string;
  /** Commit containing the complete child delta, suitable for later recovery or cleanup. */
  resultCommit?: string;
  /** Immutable copy-backend result directory for legacy/non-native callers. */
  resultPath?: string;
  /** Whether the physical directory is currently materialized on disk. */
  materialized?: boolean;
  /**
   * Isolated Runs without path-binding tools keep a scratch cwd and read the
   * WorkingState view. Resume must not treat this as an incomplete copy.
   */
  viewMode?: "virtual" | "materialized";
  /**
   * Durable directory switch journal for a frozen `writeRevision`.
   * Restart recovers to one authoritative view; it must not leave a half-switched
   * live path. Caller abort rolls the switch back to virtual.
   */
  materializationSwitch?: {
    revision: number;
    writeRevision: number;
    /** Immutable WorkingState root reconstructed into staging. */
    root: string;
    stagingPath: string;
    backupPath: string;
    stage: "staging-ready" | "live-backed-up" | "staging-promoted";
  };
  /**
   * Native Rust materialization handoff across kernel, Git metadata attach, and
   * Thread Registry commit. The same operationId/root/writeRevision is reused
   * after Host restart; a different current branch is a conflict, not a retry.
   */
  materializationHandoff?: {
    operationId: string;
    pinId: string;
    revision: number;
    writeRevision: number;
    root: string;
    view: "current" | "revision";
    nextPreparationStage: "setup" | "ready";
    stage: "intent-persisted" | "kernel-materialized" | "git-attached";
    gitKind?: "worktree" | "init" | "none";
    executionBaseline?: string;
  };
  /**
   * Durable progress through directory reconstruction and environment setup.
   * `materializing` may have a partial managed directory on disk; it is never
   * safe to open until the state advances to `setup` or `ready`.
   */
  preparationStage?: "capturing-baseline" | "materialize" | "materializing" | "setup" | "ready";
  /** Fingerprint of a failed partial materialization used to detect later user changes before retry cleanup. */
  materializationFingerprint?: string;
  /** Physical disk footprint in bytes, if measured. */
  diskBytes?: number;
  /** Files changed in the worktree if inspected or recorded. */
  changedFiles?: string[];
  /** Why a materialized directory could not be reclaimed safely. */
  retentionReason?: string;
}

/** Immutable launch inputs captured when the Thread is created. */
/**
 * Parent context captured at dispatch time for an `inherit` thread (D-285.4):
 * the committed compaction summary plus the retained raw messages rendered as
 * bounded text, with entry ids kept as history anchors. The material is fixed
 * at dispatch — a queued Thread never re-reads the parent's later state.
 */
export interface ThreadInheritedContext {
  fromSessionId: string;
  capturedAt: string;
  /** Original image bytes explicitly transferred with the fixed input. */
  images?: import("./types.js").ImageAttachment[];
  text: string;
  anchors: string[];
}



export interface ThreadLaunchManifest {
  modelSettings?: import("./harness-agents.js").HarnessAgentModelSettings;
  carryBlocks: boolean;
  concurrency: number;
  /** Host-owned immutable editor draft baseline captured at dispatch. */
  draftBaselineId: string | null;
  /** Immutable non-worktree resources captured with the first dispatched input. */
  sourceViewId?: string;
  /**
   * How the Thread's first Run input was constructed (D-285.4): `task` is a
   * fresh task brief; `inherit` carries `inheritedContext`. Later Runs carry
   * their own origin in `ThreadRunFrozenConfig.inputOrigin`.
   */
  inputOrigin?: "task" | "inherit";
  inheritedContext?: ThreadInheritedContext;
  /** Host-confirmed parent authority root fixed when this Thread was dispatched. */
  initialAuthorityRoot?: string;
  scope: string[];
  systemPromptFragment: string | null;
  tools: string[];
  /** Agent work focus frozen when this Thread was created. */
  workFocus: WorkFocusId;
  /** Optional research capability and resource request frozen at dispatch. */
  research?: ThreadResearchManifest;
  worktree: "none" | "shared" | "isolated";
  /** Frozen Host permission overlay. Nested children inherit or narrow it. */
  permissions?: PermissionPolicy;
  /**
   * Bespoke first-Run prompt that cannot be reconstructed from the manifest
   * fields. Persisted so a queued Thread still receives
   * its intended input when admission promotes it.
   */
  promptText?: string;
}

export interface ThreadTokens {
  input: number;
  output: number;
  cacheRead: number;
}

/** A party to a directed thread message: a Thread, its parent session, or the user. */
export interface ThreadMessagePeer {
  kind: "session" | "thread" | "user";
  id: string;
}

export type ThreadMessageStatus = "pending" | "held" | "delivered" | "resolved" | "failed";

/**
 * Host-recorded directed message (D-285.6 / 3.18C). `in` records live on the
 * target Thread and drive dedupe, boundary delivery, and replyTo resolution;
 * `out` records on the sender Thread mark an outstanding dependency a reply
 * can complete. Records persist so retries and restarts cannot duplicate
 * delivery or execution.
 */
export interface ThreadMessageRecord {
  /** Caller-supplied requestId for idempotent retries; Host-generated otherwise. */
  id: string;
  /** Actual calling conversation, supplied by the Host rather than the model. */
  originSessionId?: string;
  direction: "in" | "out";
  from: ThreadMessagePeer;
  to: ThreadMessagePeer;
  kind: "inform" | "request";
  text: string;
  /** Execution context policy is part of the idempotent request identity. */
  context?: "continue" | "fresh";
  replyTo?: string;
  /** Receipt for an explicit reply wait; expiry does not cancel this message. */
  wait?: { deadline: number; state: "waiting" | "elapsed" | "interrupted" };
  status: ThreadMessageStatus;
  /** A known rejected execution attempt; not an uncertain transport acknowledgement. */
  failure?: string;
  /** Run started by this request, when it scheduled execution. */
  runId?: string;
  at: string;
}

/** A selected immutable patch and its actual receiving-authority receipt. */
export interface ThreadCodeSubmission {
  id: string;
  fingerprint: string;
  fromThreadId: string;
  toThreadId: string;
  branchId: string;
  resultRevision: number;
  paths: string[];
  status: "capturing" | "queued" | "applying" | "applied" | "conflict" | "failed";
  appliedPaths: string[];
  conflictPaths: string[];
  acceptedPaths: string[];
  operationId?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
  completedSequence?: number;
  notificationsPending?: boolean;
  /** Only present before acceptance; distinguishes a live capture from a previous Host instance. */
  captureOwner?: string;
  /** Actual receiving branch/resource identity, independent of a conversation's directory changes. */
  recipientAuthority?: string;
}

export interface ThreadSubmitCodeParams {
  /** Any writable member of this task family, including parent. */
  threadId: string;
  submissionId?: string;
  files: Array<{ path: string; edits?: Array<{ before: string; after: string }> }>;
}

export interface ThreadSubmitCodeResult {
  text: string;
  submission: ThreadCodeSubmission;
}

/**
 * An execution request that arrived while the shared root execution budget
 * was full. The parked continuation promotes through the same admission path
 * as queued Threads when a slot frees.
 */
export interface ThreadPendingContinuation {
  /** Prepared before Run admission; persisted for an interrupted fresh launch. */
  preparedInput?: string;
  sourceRunId?: string;
  /**
   * Resolved upgrade frozen when the request was recorded (7B/D-300). A parked
   * capability/model re-route keeps the exact configuration it was admitted
   * with; the new Run freezes it while earlier Runs stay immutable.
   */
  frozen?: ThreadRunFrozenConfig;
  mode: "continue" | "fresh";
  task: string;
  requestId: string;
  from: ThreadMessagePeer;
  at: string;
}

export interface ThreadDiffStats {
  files: number;
  insertions: number;
  deletions: number;
}

/**
 * Durable execution-environment binding for the Thread's work: which managed
 * execution target runs its shell/process operations and which computer
 * desktop its GUI operations address. This is a placement default resolved
 * when each operation is admitted — an operation already accepted keeps the
 * target snapshot it was pinned with, so later edits never redirect
 * in-flight work. It is not a migration claim: files, shells and desktops
 * stay where their owning Host runs them.
 */
export interface ThreadEnvironment {
  /** Managed execution target id for shell/process ops; absent = this Host. */
  workTarget?: string;
  /** Computer desktop id for GUI ops; absent = the configured default resolution. */
  desktopId?: string;
  updatedAt: string;
}

export interface EnvironmentGetResult {
  /** Thread the calling session resolves to; null when it carries none. */
  threadId: string | null;
  environment: ThreadEnvironment | null;
}

export interface EnvironmentSetParams {
  /** Set the work target; `null` clears it back to this Host. */
  workTarget?: string | null;
  /** Set the computer desktop; `null` clears it back to the default resolution. */
  desktopId?: string | null;
}

export interface EnvironmentSetResult extends EnvironmentGetResult {
  previous: ThreadEnvironment | null;
  /** The real effect of the change; never reports resource migration. */
  handoff: string | null;
}

/**
 * A service access entry (execution-environment design §8.2). Keeps the
 * service's real location separate from the access path: a `forward` access
 * is a loopback listener on this Host that expires with it — never presented
 * as the service's own address or as a durable tunnel.
 */
export interface EnvironmentServiceAccess {
  id: string;
  /** Where the service actually listens. */
  service: { machineId: string; host: string; port: number };
  /** How to reach it. `direct` = the service's own address (no relay);
   * `forward` = an ephemeral loopback listener on this Host forwarding over
   * the authenticated Host↔Host channel. */
  access: {
    kind: "forward" | "direct";
    /** Machine the access address is valid on. */
    machineId: string;
    host: string;
    port: number;
    url: string;
  };
  /** Work Thread that owns this access (forwards are released with the Host). */
  threadId: string | null;
  createdAt: string;
}

export interface EnvironmentForwardParams {
  /** Managed execution target id; absent = the work's bound workTarget, else this Host. */
  target?: string;
  /** Port the service listens on at the target machine. */
  port: number;
  /** Address on the target machine; default the target's own loopback. */
  host?: string;
}

export interface EnvironmentForwardResult {
  access: EnvironmentServiceAccess;
}

export interface EnvironmentForwardListResult {
  accesses: EnvironmentServiceAccess[];
}

export interface EnvironmentForwardCloseParams {
  id: string;
}

export interface EnvironmentForwardCloseResult {
  closed: boolean;
}

export interface Thread {
  id: string;
  parent: ThreadParent;
  workspaceId: string;
  forkPoint: { entryId: string } | null;
  brief: string;
  /** Execution preset the Thread was dispatched with, if any (D-285). */
  preset: string | null;
  model: import("./harness-settings.js").ModelSelection | null;
  manifest: ThreadLaunchManifest;
  createdBy: ThreadCreatedBy;
  kind: ThreadKind;
  /** Distinguishes ordinary delegated work from the real user-session research root. */
  purpose: ThreadPurpose;
  worktree: ThreadWorktree | null;
  /** Host-owned working-state branch associated with this Thread. */
  workBranchId?: string;
  /** Latest published immutable result on workBranchId. */
  resultRevision?: number;
  lifecycle: ThreadLifecycle;
  attention: ThreadAttention;
  waitingFor: ThreadWaitingFor | null;
  dependencyWaits?: ThreadDependencyWait[];
  integration: ThreadIntegration;
  diffStats: ThreadDiffStats | null;
  report: ThreadReport | null;
  /** Host-validated retrieval draft; copied into report.evidence at settle. */
  pendingEvidence?: RetrievalEvidence;
  mergedCommit?: string;
  /** Native result revision most recently integrated into the parent. */
  mergedResultRevision?: number;
  /** Last fully integrated source, retained as the receiving baseline for later edits/reverts. */
  mergedSource?: { branchId: string; resultRevision: number; receiver: ThreadParent; recipientAuthority: string; sourcePaths: string[]; codeReceiptIds: string[] };
  /** Compact Host preview binding shared by Thread, wait, Zone 2, and the thread UI. */
  integrationBinding?: ThreadIntegrationBinding;
  /**
   * Host projection of checks and review for the current result.
   * Command exits are facts; they are not a "result verified" flag.
   */
  verification?: ThreadVerificationProjection;
  /** Source identity retained with an existing review result. */
  reviewOf?: ThreadReviewOf;
  /**
   * BC3 Bot consultation: this discussion Thread was dispatched to consult a
   * Bot. Its session runs with the Bot's persona and model default and
   * reads/writes the Bot's memory scope, while the record and the response
   * path stay in the requesting work's catalog.
   */
  consultBotId?: string;
  /**
   * Directed message ledger (inbound queue plus sender-side outstanding
   * requests). Inbound `pending`/`held` records flush into the next normal
   * input boundary; they never start execution by themselves.
   */
  messages?: ThreadMessageRecord[];
  codeSubmissions?: ThreadCodeSubmission[];
  /** Request parked behind a full shared execution budget (3.18C). */
  pendingContinuations?: ThreadPendingContinuation[];
  /**
   * Execution-environment placement binding for later-accepted operations.
   * Absent = Host defaults. Never mutated by an admitted operation.
   */
  environment?: ThreadEnvironment;
  activeRunId: string | null;
  createdAt: string;
  updatedAt: string;
  eventSeq: number;
  hidden: boolean;
  /** User-requested keep of the materialized directory across archive/reclaim. */
  keepWorktree?: boolean;
  /** Present until the durable post-order deletion reaches its commit point. */
  deletion?: ThreadDeletionState;
}

export interface ThreadSpaceMeasurement {
  logicalBytes: number | null;
  allocatedBytes: number | null;
  unknown: boolean;
}

export interface ThreadOccupancy {
  threadId: string;
  materialized: ThreadSpaceMeasurement;
  exclusiveObjects: ThreadSpaceMeasurement;
  sharedObjects: ThreadSpaceMeasurement;
  reclaimable: boolean;
  reclaimableLogicalBytes: number | null;
  keepReasons: string[];
  /** CoW/reflink backend summary from the last materialization (D-250). */
  cow?: { reflink: number; copy: number };
}

export interface WorkspaceThreadSpace {
  workspaceId: string;
  threads: ThreadOccupancy[];
  uniqueObjectLogicalBytes: number | null;
  uniqueObjectUnknown: boolean;
  materializedLogicalBytes: number | null;
  budget?: { maxBytes?: number; minFreeRatio?: number };
  freeBytes: number | null;
  status: "ok" | "over-budget" | "low-free" | "enospc" | "unknown";
  note: string;
}

export type ThreadRestoreStatus =
  | "restored"
  | "path-occupied"
  | "rebuild-failed"
  | "enospc"
  | "budget-unavailable";

export interface ThreadVerificationCommandFact {
  command: string;
  cwd: string;
  exitCode: number | null;
  cancelled: boolean;
  relation: "same-run-matching-result" | "post-merge-matching-tree" | "unbound" | "uncertain";
  inputChanged: boolean | null;
  outputHandle?: string;
}

export interface ThreadChildCheckProjection {
  resultRevision: number;
  binding: "bound" | "uncertain";
  bindingReason?: string;
  commands: ThreadVerificationCommandFact[];
  /** Fact about recorded command exits. Not "this result passed". */
  allExitedZero: boolean | null;
}

export interface ThreadParentCheckProjection {
  mergedResultRevision: number;
  mergeOperationId?: string;
  draftUnsaved: boolean;
  binding: "bound" | "uncertain" | "cannot-verify-unsaved-draft" | "not-recorded" | "not-integrated";
  note?: string;
  commands: ThreadVerificationCommandFact[];
  allExitedZero: boolean | null;
}

export interface ThreadReviewFinding {
  severity: string;
  file?: string;
  line?: number;
  message: string;
}

export interface ThreadReviewProjection {
  resultRevision: number;
  status: "none" | "queued" | "running" | "completed" | "failed" | "cancelled";
  reviewThreadId?: string;
  reviewRunId?: string;
  conclusion?: string;
  findings?: ThreadReviewFinding[];
  error?: string;
}

export interface ThreadVerificationProjection {
  currentResultRevision?: number;
  childChecks: ThreadChildCheckProjection | null;
  parentChecks: ThreadParentCheckProjection | null;
  review: ThreadReviewProjection | null;
}

export interface ThreadReviewOf {
  sourceThreadId: string;
  resultRevision: number;
}

/**
 * Execution configuration frozen at Run start (D-285): the model, tool
 * allowlist, permission overlay, scope, worktree mode, prompt fragment, and
 * input origin this Run actually runs with. Later Runs on the same Thread
 * may freeze different values; the Thread manifest projects the latest.
 */
/**
 * How a Run's input was constructed (D-285.4): `task` is a fresh task brief;
 * `inherit` carries captured parent context; `continue` resumes the retained
 * session on an existing Thread; `fresh` rebuilds the input from current
 * rules and carried evidence on a new session.
 */
export type ThreadRunInputOrigin = "task" | "inherit" | "continue" | "fresh";

export interface ThreadRunFrozenConfig {
  modelSettings?: import("./harness-agents.js").HarnessAgentModelSettings;
  model: import("./harness-settings.js").ModelSelection | null;
  tools: string[];
  permissions?: PermissionPolicy;
  scope: string[];
  worktree: "none" | "shared" | "isolated";
  systemPromptFragment: string | null;
  inputOrigin: ThreadRunInputOrigin;
  workFocus: WorkFocusId;
  research?: ThreadResearchManifest;
}

export interface ThreadRun {
  /** Immutable delivery from this attempt, independent of the Thread's latest report. */
  report?: ThreadReport;
  /** Durable execution intent consumed atomically with this Run's admission. */
  request?: ThreadPendingContinuation;
  id: string;
  threadId: string;
  attempt: number;
  runtimeId: string;
  sessionId: string | null;
  /** Whether sessionId is a spawned child or an existing user session attached to this Run. */
  sessionOwner: ThreadSessionOwner;
  /** Last published resultRevision known when this Run started, if any. */
  inputRevision?: number;
  /** Frozen execution configuration. Required by the current Host catalog validator. */
  frozen?: ThreadRunFrozenConfig;
  /** A real blocking wait yielded this Run's model slot. UI attention cannot reacquire it. */
  executionYielded?: boolean;
  workerState: ThreadRunWorkerState;
  outcome: ThreadRunOutcome | null;
  exitReason: string | null;
  tokens: ThreadTokens;
  costUsd: number | null;
  steps: number;
  lastToolCall: { name: string; at: string } | null;
  startedAt: string;
  lastActivityAt: string;
  endedAt: string | null;
}

// ── Observer cursor (incremental views, §9.3.7) ───────────────────

export interface ThreadViewCursor {
  /** Receipts for the raw observations this incremental view depends on. */
  retainedBy?: string[];
  /** Explicit addressed requests already shown, independent of UI/progress events. */
  requestIds?: string[];
  codeSubmissionStates?: Record<string, string>;
  eventSeq: number;
  resultRevision?: number;
  lifecycle: ThreadLifecycle;
  attention: ThreadAttention;
  integration: ThreadIntegration;
  activeRunId: string | null;
  workerState: ThreadRunWorkerState | null;
  outcome: ThreadRunOutcome | null;
  progressVersion: number;
  decisionsCount: number;
  diffStats: ThreadDiffStats | null;
  viewedAt: string;
}

// Provider TTL values remain telemetry for the opt-in keepalive experiment;
// they are not the default `wait` schedule.
export interface TtlTable {
  [providerId: string]: number;
}

export const DEFAULT_TTL_TABLE: TtlTable = {
  anthropic: 240_000,
  "anthropic-1h": 3_300_000,
  openai: 240_000,
  gemini: 240_000,
};

// ── Harness service methods for thread operations ─────────────────

export interface ThreadListParams {
  ids?: string[];
  full?: boolean;
}

export interface ThreadListItem {
  id: string;
  parent?: ThreadParent;
  lifecycle: ThreadLifecycle;
  attention: ThreadAttention;
  integration: ThreadIntegration;
  brief: string;
  createdAt: string;
  preset: string | null;
  updatedAt: string;
  activeRun: ThreadRun | null;
  waitingFor: ThreadWaitingFor | null;
  diffStats: ThreadDiffStats | null;
}

export interface ThreadListResult {
  observationRef?: string;
  text: string;
  threads: ThreadListItem[];
}

export interface ThreadWaitParams {
  ids?: string[];
  timeoutMs?: number;
}

export interface ThreadWaitResult {
  observationRef?: string;
  text: string;
  done: number;
  running: number;
  waiting: number;
  queued: number;
  timedOut: boolean;
}

export interface ThreadSendParams {
  /**
   * Target Thread. Reachable targets are relationship-bound (3.18C): a Thread
   * caller may reach its children, its parent, and same-parent siblings; a
   * session caller may reach its direct children.
   */
  threadId?: string;
  /** `parent` targets the caller Thread's own parent (Thread or session). */
  to?: "parent";
  message: string;
  from: "user" | "parent-agent";
  /**
   * `inform` only delivers the message — it never starts execution and does
   * not wake a waiting target. `request` asks for execution: it wakes a
   * waiting target, and on a settled implementation Thread it starts a new
   * Run (D-285.5/3.18B) or parks behind the shared execution budget.
   */
  kind?: "inform" | "request";
  /**
   * Input origin for a `request` that starts a new Run on a settled Thread:
   * `continue` resumes the retained session (default); `fresh` rebuilds the
   * input on a new session while results, files, and the old transcript stay.
   */
  context?: "continue" | "fresh";
  /**
   * Idempotency key. A retry carrying the same requestId returns the recorded
   * outcome instead of delivering or scheduling again.
   */
  requestId?: string;
  /**
   * Associates a reply with a received message. With no explicit recipient,
   * the Host routes to that message's actual sender. Only replies to requests
   * resolve an outstanding dependency; ordinary messages can also be replied to.
   */
  replyTo?: string;
  /**
   * Re-route the next Run on the target under a research capability (7B/D-300):
   * the new Run freezes the capability's tools, model, prompt fragment, and
   * resource manifest while earlier Runs stay immutable. Only valid with
   * kind "request" on a Thread that can start a new Run.
   */
  capability?: ResearchCapability;
  /** Optional resource manifest merged over the capability defaults. */
  resources?: ResearchResourceManifest;
  /**
   * Model for the next Run. An explicit selection re-routes the Thread; the
   * literal "inherit" keeps the target Thread's recorded model when the
   * capability's dedicated slot is not configured.
   */
  model?: import("./harness-settings.js").ModelSelection | "inherit";
  /**
   * Seconds to wait for the target's correlated reply after the send is
   * durably accepted (7E/D-300). 0 or absent returns the receipt at once.
   * A timeout only ends this wait — the message and the target's work are
   * unaffected, and a retry with the same requestId keeps waiting without
   * re-delivering. Only a message whose replyTo names this request counts
   * as its answer.
   */
  wait?: number;
}

export interface ThreadSendResult {
  from?: ThreadMessagePeer;
  to?: ThreadMessagePeer;
  accepted: boolean;
  lifecycle: ThreadLifecycle;
  attention: ThreadAttention;
  /** Set when the send started a new Run (request on a settled Thread). */
  runId?: string;
  /** Recorded message id; use it as `replyTo` when answering a request. */
  messageId?: string;
  /**
   * `delivered` reached the session input boundary now; `held` was recorded
   * for the next boundary or Run input; `scheduled` parked execution behind
   * the shared root budget.
   */
  delivery?: "delivered" | "held" | "scheduled";
  /** The reply that satisfied a wait, when one arrived in time. */
  reply?: {
    messageId: string;
    text: string;
    from: ThreadMessagePeer;
    at: string;
  };
  /** True when wait elapsed without a correlated reply. */
  timedOut?: boolean;
  interrupted?: boolean;
}

export type ThreadReadWhat = "blocks" | "report" | "steps" | "transcript";

export interface ThreadReadParams {
  threadId: string;
  /** One-based inclusive record range, newest records, or resume after an immutable entry id. */
  start?: number;
  end?: number;
  tail?: boolean;
  afterEntry?: string;
  /** Select an attempt or its published result instead of the latest projection. */
  runId?: string;
  resultRevision?: number;
  what?: ThreadReadWhat;
  since?: number;
  /** UTF-8 byte offset when paging a retrieval report. */
  offset?: number;
  /** UTF-8 byte length when paging a retrieval report. */
  length?: number;
  /**
   * Transcript expansion (what:"transcript"). `entry` locates one immutable
   * session entry by id — the references status excerpts and history output
   * carry — with `before`/`after` neighbours. `query`/`path`/`offset`/`limit`
   * search and page the branch instead.
   */
  entry?: string;
  before?: number;
  after?: number;
  limit?: number;
  query?: string;
  path?: string;
}

export interface ThreadReadResult {
  text: string;
  report: ThreadReport | null;
  transcriptRef: TranscriptRef | null;
  nextOffset?: number;
  eof?: boolean;
  /** Transcript page metadata (found/matches/nextOffset and scope identity). */
  details?: Record<string, import("./types.js").JsonValue>;
}

export type IntegrationApplyPhase =
  | "pending"
  | "disk-applied"
  | "surface-intent"
  | "surface-dispatched"
  | "surface-applied"
  | "surface-undone"
  | "conflict"
  | "unavailable"
  | "compensated"
  | "skipped-identical";

export type IntegrationPathDecision =
  | "identical"
  | "apply-child"
  | "keep-parent"
  | "merge-clean"
  | "conflict"
  | "unavailable";

export interface ThreadConflictResolution {
  path: string;
  choice: "parent" | "child" | "base" | "text";
  text?: string;
  expectedParentRevision?: string;
  expectedLocalEditRevision?: number;
}

export interface IntegrationPathBinding {
  target: "disk" | "surface" | "unavailable";
  revision: string;
  localEditRevision?: number;
  baseRevision?: string | null;
  ownerId?: string;
  ownerGeneration?: number;
  ownerRegistrationId?: string;
  documentInstanceId?: string;
  bufferHash?: string;
  encoding?: string;
  bom?: boolean;
  lineEnding?: "lf" | "crlf" | "cr";
}

export interface IntegrationPathProjection {
  path: string;
  target: IntegrationPathBinding["target"];
  decision: IntegrationPathDecision;
  phase: IntegrationApplyPhase;
  isText: boolean;
  conflictReason?: string;
  parentText?: string;
  childText?: string;
  baselineText?: string;
}

export interface ThreadIntegrationBinding {
  operationId: string;
  resultRevision: number;
  bindingFingerprint: string;
  valid: boolean;
  mergeReady: boolean;
  conflictPaths: string[];
  surfaceTargetPaths: string[];
  unavailablePaths: string[];
}

export const threadIntegrationBindingFromPreview = (
  preview: ThreadIntegrationPreview,
): ThreadIntegrationBinding => ({
  operationId: preview.operationId,
  resultRevision: preview.resultRevision,
  bindingFingerprint: preview.bindingFingerprint,
  valid: preview.valid,
  mergeReady: preview.mergeReady,
  conflictPaths: [...preview.conflictPaths],
  surfaceTargetPaths: [...preview.surfaceTargetPaths],
  unavailablePaths: [...preview.unavailablePaths],
});

export interface ThreadIntegrationPreview {
  operationId: string;
  threadId: string;
  resultRevision: number;
  bindingFingerprint: string;
  valid: boolean;
  mergeReady: boolean;
  binding: Record<string, IntegrationPathBinding>;
  paths: IntegrationPathProjection[];
  conflictPaths: string[];
  surfaceTargetPaths: string[];
  unavailablePaths: string[];
  appliedPaths: string[];
  invalidReason?: string;
}

export interface ThreadMergeParams {
  threadId: string;
  /** Omit to integrate the latest published result. */
  resultRevision?: number;
  /** Required when submitting conflict resolutions from a prior preview. */
  expectedBindingFingerprint?: string;
  resolutions?: ThreadConflictResolution[];
}

export interface ThreadMergeResult {
  text: string;
  merged: number;
  conflicts: string[];
  /** Draft paths that must be applied through Document Registry, not disk. */
  surfaceTargetPaths?: string[];
  preview?: ThreadIntegrationPreview;
  status?: "applied" | "conflict" | "compensated" | "needs-attention";
  appliedPaths?: string[];
  resultRevision?: number;
  operationId?: string;
}

export interface ThreadUpdateParams {
  threadId: string;
  /**
   * Published parent result revision to incorporate into the thread's working
   * baseline. Omit to use the parent thread's latest published result.
   */
  resultRevision?: number;
}

export interface ThreadUpdateResult {
  text: string;
  status: "applied" | "conflict" | "needs-attention";
  /** The parent result revision that became the thread's new baseline. */
  resultRevision?: number;
  /** Identity of the new baseline (`branchId@revision` or an immutable root). */
  baseRef?: string;
  /** Paths that adopted the parent revision's bytes. */
  updatedFromParent?: string[];
  /** Paths where the thread's own change was preserved over the new base. */
  keptPaths?: string[];
  /** Paths textually merged clean across both sides. */
  mergedPaths?: string[];
  /** Paths where both sides diverged; the thread's bytes were kept. */
  conflicts?: { path: string; reason?: string }[];
}

export interface ThreadKillParams {
  threadId: string;
  keepWorktree?: boolean;
}

export interface ThreadKillResult {
  text: string;
}

export interface ThreadDispatchParams {
  /** Frozen parent-session setting; not exposed as a model tool argument. */
  concurrency?: number;
  task: string;
  /**
   * Thread kind. Default `implementation` — a work-producing child Thread.
   * `discussion` spawns a read-only consult Thread bound to the same owning
   * scope: it answers questions against durable memory and workspace material
   * and reports back through its result, without claiming worktree ownership.
   */
  kind?: "implementation" | "discussion";
  /**
   * BC3 Bot consultation — valid only with kind:"discussion". The consult
   * Thread stays under the requesting work's catalog and parent (the existing
   * send/wait/report path carries the answer back), while its session is bound
   * to the named Bot: Bot persona instructions, Bot model default, and the
   * `bot:<id>` memory scope.
   */
  bot?: string;
  /**
   * Optional execution preset id. Absent = normal dispatch on the caller's
   * current model and authorized tools (D-285).
   */
  preset?: string;
  scope?: string[];
  /**
   * Explicit shared WorkingState opt-in. Default for write-capable work is
   * an isolated WorkingState materialized on demand; presets no longer force
   * `shared` (D-285).
   */
  worktree?: "shared";
  /**
   * Resolved by pi-host: the preset's model (slot or explicit inherit), or
   * the dispatching session's current model for a normal dispatch.
   */
  model?: import("./harness-settings.js").ModelSelection;
  /**
   * Resolved by pi-host for a preset-less dispatch: the dispatching
   * session's active tool names. The Host clamps it to the owning Thread's
   * frozen allowlist; presets use their declared tool list instead.
   */
  tools?: string[];
  /**
   * Input origin for the new Thread (D-285.4): `task` (default) seeds only
   * the task brief; `inherit` captures the parent's committed summary and
   * retained raw messages at dispatch time and prepends them to the task.
   */
  input?: "task" | "inherit";
  /** Research capability is explicit and only available when its model slot is configured. */
  research?: ThreadResearchManifest;
  /**
   * Initial execution-environment binding for the new Thread. Absent =
   * inherit the parent Thread's binding, or Host defaults at the root.
   */
  environment?: { workTarget?: string; desktopId?: string };
}

export interface ThreadFactsSetParams {
  question: string;
  facts: Array<{
    claim: string;
    sources: Array<{
      kind: "local" | "url" | "output";
      path?: string;
      startLine?: number;
      endLine?: number;
      url?: string;
      receiptId?: string;
      outputRef?: RetrievalOutputRef;
    }>;
  }>;
  unknowns?: string[];
  attempted?: Array<{
    action: string;
    outcome: "rejected" | "unavailable" | "empty" | "failed";
    detail?: string;
  }>;
}

export interface ThreadFactsSetResult {
  text: string;
  evidence: RetrievalEvidence;
}

export interface ThreadDispatchResult {
  text: string;
  threadId: string;
  queued: boolean;
}
