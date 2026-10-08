import type { ThreadDiffStats } from "@varin/protocol";
import type {
  RecoveryState,
  RegularFileState,
  SymlinkState,
  DirectoryState,
  MissingState,
  UnsupportedState,
} from "../../recovery/journal-files.js";
import type { RecoveryIdentity, RecoveryFileStore } from "../../recovery/journal-files.js";
import type { RecoveryDurableOperationPort } from "../../recovery/journal-engine.js";

export interface WorkingStateRootContext {
  identity: RecoveryIdentity;
  root: string;
  fileStore: RecoveryFileStore;
  resourceOperationGate: { run<T>(resources: readonly { resourceId: string; scope: "exact" | "subtree" }[], operation: () => Promise<T>): Promise<T> };
  records?: unknown;
  client?: unknown;
  collectUnreachableObjects?: () => Promise<{ byteLengthReclaimed: number; objectsDeleted: number }>;
  durableRecoveryStore?: RecoveryDurableOperationPort;
  resolveDirectoryApplyContext?: (directory: string) => Promise<{
    workspaceId: string;
    resourceOperationGate: WorkingStateRootContext["resourceOperationGate"];
  }>;
}

export type {
  RecoveryState,
  RegularFileState,
  SymlinkState,
  DirectoryState,
  MissingState,
  UnsupportedState,
};

export interface ContentObject {
  hash: string;
  bytes: Buffer;
  byteLength: number;
}

export interface WorkingBranch {
  branchId: string;
  workspaceId: string;
  baseRef?: string | undefined;
  baseState: Record<string, RecoveryState>;
  /** Paths whose effective base state was determined by unsaved surface drafts, including structural closure. */
  draftBasePaths: string[];
  /** Relative file or directory roots copied from harness.worktree.copyIgnored at launch. */
  captureScopes: string[];
  deltas: Record<string, RecoveryState>;
  headRevision: number;
  /** Monotonic CAS token for unpublished virtual writes (D-213). */
  writeRevision: number;
  /** Generation of the branch baseline; bumped by every rebaseBranch. */
  baseRevision?: number;
  /** Superseded baselines retained so older published results keep resolving
   * against the base they were published on. */
  baseLineage?: Record<number, Record<string, RecoveryState>>;
  createdAt: string;
  updatedAt: string;
}

/** Root identity and CAS metadata. Tree entries stay behind the asynchronous path/range API. */
export interface WorkingBranchRoot {
  branchId: string;
  workspaceId: string;
  baseRef?: string;
  baseRoot: string;
  root: string;
  headRevision: number;
  writeRevision: number;
  draftBasePaths: string[];
  captureScopes: string[];
  createdAt: number;
  updatedAt: number;
}

export type WorkingStatePathOrigin = "base" | "delta" | "draft-base";

export type WorkingStateContentSource =
  | { kind: "branch"; branchId: string; path: string; revision?: number }
  | { kind: "pin"; pinId: string; path: string };

export interface WorkingStateTreeEntry {
  path: string;
  state: RecoveryState;
  origin: WorkingStatePathOrigin;
  root?: string;
  viewRevision?: number;
  contentSource?: WorkingStateContentSource;
}

export interface WorkingStateTreeRead {
  branch: WorkingBranchRoot;
  /** The immutable/current root actually read. */
  root: string;
  /** Published revision for fixed reads; writeRevision for the current view. */
  viewRevision: number;
  entries: WorkingStateTreeEntry[];
}

export interface WorkingStateReadOptions {
  revision?: number;
  pin?: WorkingStatePinnedRoot;
  signal?: AbortSignal;
  deadlineAt?: number;
}

export interface WorkingStatePinnedRoot {
  pinId: string;
  branchId: string;
  workspaceId: string;
  view: "current" | "revision";
  revision: number;
  writeRevision: number;
  root: string;
  branch: WorkingBranchRoot;
}

export interface WorkingStatePin extends WorkingStatePinnedRoot {
  release(): Promise<void>;
}

/**
 * Branch roots and paths are asynchronous because the Rust kernel owns them.
 * Implementations must not retain an expanded workspace tree between operations.
 */
export interface WorkingStateRootStore {
  queryFiles(pin: WorkingStatePinnedRoot, request: import("./query-contract.js").WorkingStateFileQuery, options?: import("./query-contract.js").WorkingStateQueryOptions): Promise<import("./query-contract.js").WorkingStateQueryResult>;
  getBranchRoot(branchId: string, options?: { signal?: AbortSignal }): Promise<WorkingBranchRoot | null>;
  /** Read a published result by its immutable branch/revision identity. The returned state maps are
   * restricted to changedPaths; callers must use readStateSlice for any additional paths. */
  getResult(branchId: string, revision: number, options?: { signal?: AbortSignal }): Promise<WorkingResult | null>;
  readStateSlice(branchId: string, paths: readonly string[], options?: WorkingStateReadOptions): Promise<Record<string, RecoveryState> | null>;
  readPath(branchId: string, path: string, options?: WorkingStateReadOptions): Promise<WorkingStateTreeEntry | null>;
  listPaths(branchId: string, roots: readonly string[], options?: WorkingStateReadOptions): Promise<WorkingStateTreeRead | null>;
  readContent(entry: WorkingStateTreeEntry, options?: { offset?: number; length?: number; signal?: AbortSignal }): Promise<Buffer | null>;
  getObject(hash: string): Promise<Buffer | null>;
  getObjectSlice(hash: string, byteLength: number, offset: number, length: number): Promise<Buffer | null>;
  ownerIdForObject?(hash: string): string | undefined;
  pinBranch(branchId: string, options?: { revision?: number; signal?: AbortSignal }): Promise<WorkingStatePin>;
  /** Kernel-only durable pin used by a persisted materialization handoff. */
  pinBranchHandoff?(branchId: string, pinId: string, options?: { revision?: number; signal?: AbortSignal }): Promise<WorkingStatePin>;
  /** Reopen the exact durable pin after Host restart; never substitutes the current branch root. */
  openBranchHandoffPin?(branchId: string, pinId: string, expected: { root: string; revision: number; writeRevision: number }, signal?: AbortSignal): Promise<WorkingStatePin>;
  releaseBranchHandoffPin?(branchId: string, pinId: string): Promise<void>;
  putObject(bytes: Buffer): Promise<{ hash: string; byteLength: number }>;
  createDraftBaseline(workspaceId: string, paths: readonly { path: string; content: string | Buffer; mode?: number; provenance: DraftBaselinePathProvenance }[]): Promise<DraftBaseline>;
  getDraftBaseline(id: string): Promise<DraftBaseline | null>;
  deleteDraftBaseline(id: string): Promise<void>;
  createBranch(workspaceId: string, branchId: string, baseState: Record<string, RecoveryState>, baseRef?: string, draftBasePaths?: string[], captureScopes?: string[]): Promise<WorkingBranchRoot>;
  createBranchFromPin(workspaceId: string, branchId: string, pin: WorkingStatePin, parentRef: string, draftBaselineId?: string | null, captureScopes?: string[]): Promise<WorkingBranchRoot>;
  captureDirectory(directory: string, relativePaths?: string[], options?: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; store?: boolean; indexModes?: Map<string, string> | Record<string, string> }): Promise<Record<string, RecoveryState>>;
  listCaptureScopePaths(directory: string, scopes: readonly string[], signal?: AbortSignal): Promise<string[]>;
  listWorkspaceBaselinePaths(directory: string, signal?: AbortSignal): Promise<string[]>;
  commitVirtualWrites(
    branchId: string,
    expectedWriteRevision: number,
    files: Record<string, RecoveryState>,
  ): Promise<{ status: "committed"; writeRevision: number; root?: string } | { status: "conflict"; writeRevision: number; root?: string }>;
  /** Atomically move the branch baseline to a new immutable parent state while
   * preserving the surviving deltas in `changes` (the complete new delta set,
   * not a patch). `baseRef` is a kernel-resolvable ref (root hash, pin:id, or
   * branchId@revision); `parentRef` is recorded as lineage metadata. */
  rebaseBranch(
    branchId: string,
    expectedWriteRevision: number,
    rebase: {
      baseRef: string;
      parentRef?: string;
      /** Full state map of the new baseline; used by non-kernel stores. */
      baseState?: Record<string, RecoveryState>;
      changes: Record<string, RecoveryState>;
    },
  ): Promise<{ status: "committed"; writeRevision: number; root?: string } | { status: "conflict"; writeRevision: number; root?: string }>;
  materializeResult(branchId: string, revision: number, directory: string): Promise<import("./materializer.js").MaterializeResult>;
  materializePin(pin: WorkingStatePin, directory: string): Promise<import("./materializer.js").MaterializeResult>;
  /** Production Rust backend can atomically materialize directly into the live managed directory. */
  materializePinManaged?(
    pin: WorkingStatePin,
    directory: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<import("./materializer.js").MaterializeResult>;
  measurePin(pin: WorkingStatePin): Promise<import("@varin/protocol").ThreadSpaceMeasurement>;
  directoryMatchesResult(branchId: string, revision: number, directory: string): Promise<boolean>;
  captureBranchCandidateIdentity(branchId: string, directory: string, changedPaths: string[]): Promise<string | null>;
  captureSeededPathIdentity(directory: string, changedPaths: string[], seed: string): Promise<string>;
  publishHeadResult(branchId: string): Promise<WorkingResult>;
  publishDirectoryResult(branchId: string, directory: string, changedPaths?: string[], options?: { indexModes?: Map<string, string> | Record<string, string>; validateFixedSource?: () => Promise<boolean> }): Promise<WorkingResult>;
  resultTreeIdentity(branchId: string, revision: number): Promise<string | null>;
  listResults(branchId?: string): Promise<WorkingResult[]>;
  deleteResults(branchId: string, revisions: readonly number[]): Promise<number[]>;
  deleteBranch(branchId: string): Promise<void>;
  collectUnreachableObjects(): Promise<{ byteLengthReclaimed: number; objectsDeleted: number }>;
  listDurableOperations(kind?: string): Promise<Record<string, unknown>[]>;
  listBranchObjectReferences(branchId: string): Promise<Array<{ hash: string; byteLength: number | null }>>;
  listDraftObjectReferences(id: string): Promise<Array<{ hash: string; byteLength: number | null }>>;
  listChildVerifications(threadId: string): Promise<ResultVerificationBundle[]>;
  listParentVerifications(threadId: string): Promise<ParentVerificationBundle[]>;
  listReviewRecords(threadId: string): Promise<ResultReviewRecord[]>;
  getChildVerification(threadId: string, revision: number): Promise<ResultVerificationBundle | null>;
  getParentVerification(threadId: string, revision?: number): Promise<ParentVerificationBundle | null>;
  getReviewRecord(threadId: string, revision: number): Promise<ResultReviewRecord | null>;
  putChildVerification(threadId: string, bundle: ResultVerificationBundle): Promise<void>;
  putParentVerification(threadId: string, branchId: string, bundle: ParentVerificationBundle): Promise<void>;
  putReviewRecord(threadId: string, branchId: string, record: ResultReviewRecord): Promise<void>;
}

export interface WorkspaceWorkingStateRootAccess {
  withBranchStore<T>(
    workspaceId: string,
    purpose: string,
    operation: (store: WorkingStateRootStore, context?: WorkingStateRootContext) => Promise<T> | T,
    mode?: "exclusive" | "shared",
    actor?: { sessionId?: string; threadId?: string; runId?: string; executionWorkspace?: string },
  ): Promise<T>;
}

export interface DraftBaselinePathProvenance {
  baseRevision: string | null;
  encoding: string;
  bom: boolean;
  localEditRevision: number;
  revision: string;
}

export interface DraftBaseline {
  id: string;
  workspaceId: string;
  createdAt: string;
  pathStates: Record<string, RecoveryState>;
  provenance: Record<string, DraftBaselinePathProvenance>;
}

export interface WorkingResult {
  resultRevision: number;
  branchId: string;
  parentRef?: string | undefined;
  changedPaths: string[];
  /** Fixed baseline states for every changed path. */
  baseStates: Record<string, RecoveryState>;
  /** Fixed result states for every changed path. */
  pathStates: Record<string, RecoveryState>;
  diffStats: ThreadDiffStats;
  createdAt: string;
  /** Baseline generation this result was published against (non-kernel stores). */
  baseRevision?: number;
  /** Rust-kernel root bound to resultRevision when the kernel is authoritative. */
  root?: string;
}

export type ThreeWayPathDecision =
  | "identical"
  | "apply-child"
  | "keep-parent"
  | "merge-clean"
  | "conflict";

export interface ThreeWayPathPlan {
  path: string;
  decision: ThreeWayPathDecision;
  baseState: RecoveryState;
  parentState: RecoveryState;
  childState: RecoveryState;
  mergedText?: string;
  mergedMode?: number;
  conflictMarkers?: string;
  conflictReason?: string;
  isText: boolean;
}

export interface ThreeWayMergePlan {
  operationId: string;
  workspaceId: string;
  threadId: string;
  resultRevision: number | string;
  clean: boolean;
  paths: ThreeWayPathPlan[];
  appliedPaths: string[];
  conflictPaths: string[];
  diffStats: ThreadDiffStats;
}

export type CommandInputRelation =
  | "same-run-matching-result"
  | "post-merge-matching-tree"
  | "unbound"
  | "uncertain";

export interface VerificationActorIdentity {
  authorityInstanceId: string;
  sessionId: string;
  workerId: string;
  workerGeneration: number;
  runId?: string;
}

export interface CommandVerificationRecord {
  id: string;
  runId: string;
  command: string;
  cwd: string;
  envSummary?: { PATH?: boolean; VIRTUAL_ENV?: string };
  commandRunId?: string;
  startedAt: number;
  endedAt: number;
  exitCode: number | null;
  cancelled: boolean;
  outputHandle?: string;
  outputPreview?: string;
  actor: VerificationActorIdentity;
  bindingGeneration: number;
  inputIdentity: {
    kind: "tree" | "unbound";
    branchId?: string;
    root?: string;
    startTreeHash?: string;
    endTreeHash?: string;
    reason?: string;
  };
  inputChangedDuringRun: boolean | null;
  relationToPublished: CommandInputRelation;
}

export interface ResultVerificationBundle {
  resultRevision: number;
  branchId: string;
  resultTreeHash?: string;
  recordedAt: number;
  binding: "bound" | "uncertain";
  bindingReason?: string;
  checks: CommandVerificationRecord[];
}

export interface ParentVerificationBundle {
  mergedResultRevision: number;
  branchId?: string;
  mergeOperationId?: string;
  parentTreeHash?: string;
  windowOpenedAt?: number;
  recordedAt: number;
  draftUnsaved: boolean;
  note?: string;
  binding: "bound" | "uncertain" | "cannot-verify-unsaved-draft" | "not-recorded" | "not-integrated";
  checks: CommandVerificationRecord[];
}

export interface ResultReviewRecord {
  resultRevision: number;
  /** `queued` is dispatched behind a full shared execution budget; `running` has a bound Run. */
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  recordedAt: number;
  reviewThreadId?: string;
  reviewRunId?: string;
  conclusion?: string;
  findings?: Array<{ severity: string; file?: string; line?: number; message: string }>;
  error?: string;
}

export interface WorkingStateVerifications {
  child: Record<string, ResultVerificationBundle[]>;
  parent: Record<string, ParentVerificationBundle[]>;
  reviews: Record<string, ResultReviewRecord[]>;
}

export interface IntegrationApplyResult {
  operationId: string;
  status: "applied" | "conflict" | "compensated" | "needs-attention";
  appliedPaths: string[];
  conflictPaths: string[];
  /** Draft-derived paths that require reconciliation with the originating editor surface. */
  surfaceTargetPaths?: string[];
  preview?: import("@varin/protocol").ThreadIntegrationPreview;
  compensatedPaths?: string[];
  needsAttentionPaths?: string[];
  diffStats: ThreadDiffStats;
  text: string;
}
