import path from "node:path";
import { canonicalizePathIdentity } from "../workspace/path-safety.js";
import { createHash, randomUUID } from "node:crypto";
import {
  parseWorkspaceCombinedRecoveryPlan,
  parseWorkspaceRecoveryFailure,
  type RecoveryConversation,
  type RecoveryFileTarget,
  type RecoveryRetentionPolicyInput,
  type RecoveryRetentionStatusResult,
  type RecoveryStorageCleanupInput,
  type RecoveryStorageCleanupOperationResult,
  type RecoveryStorageLocation,
  type RecoveryStorageMoveResult,
  type RecoveryStorageStatusResult,
  type RecoveryStorageWorkspaceListResult,
  type SetRecoveryStorageLocationInput,
  type WorkspaceCombinedRecoveryApplyInput,
  type WorkspaceCombinedRecoveryCoverage,
  type WorkspaceCombinedRecoveryListResult,
  type WorkspaceCombinedRecoveryOperation,
  type WorkspaceCombinedRecoveryOperationResult,
  type WorkspaceCombinedRecoveryOperationState,
  type WorkspaceCombinedRecoveryPlan,
  type WorkspaceCombinedRecoveryPrepareInput,
  type WorkspaceCombinedRecoveryPrepareResult,
  type WorkspaceRecoveryCheckpointInput,
  type WorkspaceRecoveryCheckpointListResult,
  type WorkspaceRecoveryCheckpointQuery,
  type WorkspaceRecoveryCheckpointResult,
  type WorkspaceRecoveryCheckpointSummary,
  type WorkspaceRecoveryConflict,
  type WorkspaceRecoveryEntryBindingResult,
  type WorkspaceRecoveryEntryTarget,
  type WorkspaceRecoveryFailedResult,
  type WorkspaceRecoveryFailure,
  type WorkspaceRecoveryFailureCode,
  type WorkspaceRecoveryMutationAfterInput,
  type WorkspaceRecoveryMutationBeforeInput,
  type WorkspaceRecoveryMutationResult,
  type WorkspaceRecoveryStatusResult,
  type WorkspaceRecoveryTurnBinding,
  type WorkspaceRecoveryTurnBindingResult,
  type WorkspaceRecoveryTurnSettledInput,
  type WorkspaceRecoveryTurnStartInput,
  type WorkspaceRecoveryUncoveredPath,
} from "@varin/extension-contract";
import { failedRecoveryResult, RecoveryPrimitiveError, recoveryFailure } from "./errors.js";
import type { DocumentSurfaceBinding, DocumentSurfaceOperationRequest, DocumentSurfaceOperationResult } from '../documents/authority.js';
import { createSurfaceRecovery, parseCombinedSafety, parseCombinedTarget, surfaceOwnerKey,
  type CombinedRecoverySafety, type CombinedRecoveryTarget, type RecoverySurfaceOwner, type RecoverySurfaceTarget } from './surface-recovery.js';
import {
  normalizeResourceId,
  parseRecoveryState,
  sameState,
  stateIdentity,
  type RecoveryFileStore,
  type RecoveryIdentity,
  type RecoveryState,
} from "./journal-files.js";
import {
  reconcileInterruptedIntegrationOperations,
  type DurableFileOperationContext,
  type HostFileResourceBackend,
  type HostResourceOperation,
  type HostResourceOperationGate,
  type ResolveDirectoryApplyContext,
} from "./durable-file-operation.js";

interface WorkspaceRegistration { canonicalPath: string; workspaceId: string }
interface DirtyBufferResource {
  bufferHash?: string;
  documentInstanceId?: string;
  encoding?: string;
  bom?: boolean;
  lineEnding?: 'lf' | 'crlf' | 'cr';
  baseRevision: string | null;
  localEditRevision: number;
  resource: { resourceId: string; workspaceId?: string };
}
interface DirtyBufferPublication {
  registrationId?: string;
  generation: number;
  ownerId: string;
  resources: DirtyBufferResource[];
  workspaceId: string;
}
interface DirtyBarrierHandle { barrierId?: string; release(): Promise<void>; settle(): Promise<void> }
interface TargetBarrierHandle extends DirtyBarrierHandle { barrierFor(workspaceId: string): string }
interface RecoveryDocumentsAuthority {
  beginDirtyStateBarrier?: (workspaceId: string, paths: string[], options: { caseSensitive: boolean }) => Promise<DirtyBarrierHandle>;
  inspectDirtyBuffers(workspaceId: string): Promise<DirtyBufferPublication[]>;
  inspectWorkspace(workspaceId: string): Promise<{ root: string; workspaceId: string }>;
  listWorkspaceRegistrations(): Promise<WorkspaceRegistration[]>;
  runResourceOperation?<T>(workspaceId: string, resources: readonly HostResourceOperation[], operation: () => Promise<T>): Promise<T>;
  requestSurfaceOperation?(request: DocumentSurfaceOperationRequest): Promise<DocumentSurfaceOperationResult[]>;
}
interface NavigationPrepared {
  journalTurns?: Array<{ workspaceId: string; executionId: string; restore: boolean }>;
  editorImages?: WorkspaceCombinedRecoveryOperation["editorImages"];
  editorText?: string;
  expectedLeafId: string | null;
  removedEntryIds?: string[];
  targetLeafId: string | null;
}
interface NavigationCommitted {
  editorImages?: WorkspaceCombinedRecoveryOperation["editorImages"];
  editorText?: string;
  markerId?: string;
  navigationMarkerId?: string;
}
export interface RecoverySessionNavigation {
  ready?(conversation: RecoveryConversation): boolean;
  commit(input: { entryId: string; expectedLeafId: string | null; operationId: string; preparedTargetLeafId: string | null; conversation: RecoveryConversation; workspaceId: string; undoOf?: string }): Promise<NavigationCommitted>;
  commitLeaf(input: { expectedLeafId: string | null; operationId: string; preparedTargetLeafId: string | null; conversation: RecoveryConversation; workspaceId: string; undoOf?: string }): Promise<NavigationCommitted>;
  prepare(input: WorkspaceCombinedRecoveryPrepareInput): Promise<NavigationPrepared>;
  prepareLeaf(input: { conversation: RecoveryConversation; undoOf?: string; targetLeafId: string | null; workspaceId: string }): Promise<NavigationPrepared>;
}

export interface DurableRecoveryChangeSelection {
  changes: Array<{ after: RecoveryState; before: RecoveryState; checkpointId: string; executionId: string; mutationId: string; path: string; sequence: number; toolName: string; fileTarget?: RecoveryFileTarget }>;
  turns: Array<{ fileTarget?: RecoveryFileTarget; activeWriterScopes: string[]; checkpointId: string; executionId: string; failure?: Record<string, unknown>; sequence: number; status: string; unrecordedResourceIds: string[] }>;
}
export interface RecoveryOperationConflict {
  operationId: string; workspaceId: string; state: string; revision: number; canonicalRoot: string; paths: string[];
}
export interface RecoveryOperationConflictQuery {
  workspaceId: string; canonicalRoot: string; paths: string[]; exceptOperationId?: string;
}
export interface RecoveryDurableOperationPort {
  /** Register an already-owned candidate for transfer into the existing journal refs. */
  registerObjectOwner?(workspaceId: string, hash: string, ownerId: string): void;
  createOperation(input: { operationId: string; workspaceId: string; kind: string; state: string; data: Record<string, unknown>; targets: Record<string, { expected?: RecoveryState; target?: RecoveryState; safety?: RecoveryState }>; surfacePaths?: readonly string[]; sessionId?: string; threadId?: string; runId?: string }): Promise<Record<string, unknown>>;
  updateOperationFile(input: { operationId: string; workspaceId: string; path: string; expectedRevision: number; expectedPhase: string; phase: string; observedFingerprint?: string; expected?: RecoveryState; target?: RecoveryState; safety?: RecoveryState; sessionId?: string }): Promise<Record<string, unknown>>;
  completeOperation(input: { operationId: string; workspaceId: string; expectedRevision: number; state: string; result?: Record<string, unknown>; failure?: Record<string, unknown>; sessionId?: string }): Promise<Record<string, unknown>>;
  getOperation(workspaceId: string, operationId: string, sessionId?: string): Promise<Record<string, unknown> | null>;
  listOperations(workspaceId: string, kind?: string): Promise<Record<string, unknown>[]>;
  /** Original journal reservations across physical root aliases, restricted to the admitted target. */
  listOperationConflicts(input: RecoveryOperationConflictQuery): Promise<RecoveryOperationConflict[]>;
  releaseOperation(workspaceId: string, operationId: string): Promise<Record<string, unknown>>;
  listChanges?(input: { workspaceId: string; conversation?: RecoveryConversation; executionId?: string; entryIds?: string[] }): Promise<DurableRecoveryChangeSelection>;
  /** Internal Host-only binding of a completed Integration into an active recovery turn. */
  recordIntegrationChanges?(input: {
    workspaceId: string; executionId: string; operationId: string;
    changes: Record<string, { before: RecoveryState; after: RecoveryState }>;
  }): Promise<boolean>;
}
export interface RecoveryDurableMetadataPort extends RecoveryDurableOperationPort {
  createNamedCheckpoint(workspaceId: string, name: string): Promise<WorkspaceRecoveryCheckpointSummary>;
  listCheckpoints(workspaceId: string): Promise<WorkspaceRecoveryCheckpointSummary[]>;
  recordMutationAfter(input: WorkspaceRecoveryMutationAfterInput): Promise<boolean>;
  recordMutationBefore(input: WorkspaceRecoveryMutationBeforeInput): Promise<boolean>;
  recordTurnSettled(input: WorkspaceRecoveryTurnSettledInput): Promise<WorkspaceRecoveryTurnBinding>;
  recordTurnStart(input: WorkspaceRecoveryTurnStartInput): Promise<WorkspaceRecoveryTurnBinding>;
  resolveEntry(input: WorkspaceRecoveryEntryTarget): Promise<WorkspaceRecoveryEntryBindingResult>;
  health?(): Promise<{ catalogBytes?: number; walBytes?: number; blobs?: number }>;
  collectUnreachableObjects?(workspaceId: string): Promise<{ byteLengthReclaimed: number; objectsDeleted: number }>;
}
export interface CreateWorkspaceRecoveryEngineOptions {
  authorityId: string;
  dataDir: string;
  documents: RecoveryDocumentsAuthority;
  durableRecoveryStore: RecoveryDurableMetadataPort;
  fileStore: RecoveryFileStore;
  sessionNavigation: RecoverySessionNavigation;
  resolveDirectoryApplyContext?: ResolveDirectoryApplyContext;
}
export interface WorkspaceRecoveryStorageContext {
  durableRecoveryStore: RecoveryDurableOperationPort;
  fileStore: RecoveryFileStore;
  fileResources?: HostFileResourceBackend;
  identity: RecoveryIdentity;
  resourceOperationGate: HostResourceOperationGate;
  root: string;
  resolveDirectoryApplyContext?: ResolveDirectoryApplyContext;
  collectUnreachableObjects?: () => Promise<{ byteLengthReclaimed: number; objectsDeleted: number }>;
}
export interface WorkspaceRecoveryEngine {
  applyCombinedRecovery(input: WorkspaceCombinedRecoveryApplyInput): Promise<WorkspaceCombinedRecoveryOperationResult>;
  cancelCombinedOperation(operationId: string): Promise<WorkspaceCombinedRecoveryOperationResult>;
  clearStorageLocationOverride(workspaceId: string): Promise<RecoveryStorageMoveResult>;
  cleanupStorage(input: RecoveryStorageCleanupInput): Promise<RecoveryStorageCleanupOperationResult>;
  createCheckpoint(input: WorkspaceRecoveryCheckpointInput): Promise<WorkspaceRecoveryCheckpointResult>;
  deleteWorkspaceHistory(workspaceId: string): Promise<RecoveryStorageCleanupOperationResult>;
  fenceUnfinishedOperations(): Promise<WorkspaceCombinedRecoveryOperation[]>;
  getCombinedOperation(operationId: string): Promise<WorkspaceCombinedRecoveryOperationResult>;
  getStorageMove(operationId: string): Promise<RecoveryStorageMoveResult>;
  listCheckpoints(input: WorkspaceRecoveryCheckpointQuery): Promise<WorkspaceRecoveryCheckpointListResult>;
  listCombinedOperations(workspaceId: string): Promise<WorkspaceCombinedRecoveryListResult>;
  listStorageWorkspaces(): Promise<RecoveryStorageWorkspaceListResult>;
  prepareCombinedRecovery(input: WorkspaceCombinedRecoveryPrepareInput): Promise<WorkspaceCombinedRecoveryPrepareResult>;
  prepareCombinedUndo(operationId: string): Promise<WorkspaceCombinedRecoveryPrepareResult>;
  recordMutationAfter(input: WorkspaceRecoveryMutationAfterInput): Promise<WorkspaceRecoveryMutationResult>;
  recordMutationBefore(input: WorkspaceRecoveryMutationBeforeInput): Promise<WorkspaceRecoveryMutationResult>;
  recordTurnSettled(input: WorkspaceRecoveryTurnSettledInput): Promise<WorkspaceRecoveryTurnBindingResult>;
  recordTurnStart(input: WorkspaceRecoveryTurnStartInput): Promise<WorkspaceRecoveryTurnBindingResult>;
  retentionStatus(workspaceId: string): Promise<RecoveryRetentionStatusResult>;
  resolveEntry(input: WorkspaceRecoveryEntryTarget): Promise<WorkspaceRecoveryEntryBindingResult>;
  resumeCombinedOperations(): Promise<WorkspaceCombinedRecoveryOperation[]>;
  resumeWorkspaceOperations(): Promise<never[]>;
  setDefaultStorageLocation(location: RecoveryStorageLocation): Promise<RecoveryStorageStatusResult>;
  setRetentionPolicy(input: RecoveryRetentionPolicyInput): Promise<RecoveryRetentionStatusResult>;
  setStorageLocation(input: SetRecoveryStorageLocationInput): Promise<RecoveryStorageMoveResult>;
  status(workspaceId: string): Promise<WorkspaceRecoveryStatusResult>;
  storageStatus(workspaceId?: string): Promise<RecoveryStorageStatusResult>;
  /** Coordinates a compound metadata step without minting a storage authority. */
  coordinateWorkspaceStorage<T>(workspaceId: string, options: { mode: "exclusive" | "shared"; purpose: string }, operation: () => Promise<T> | T): Promise<T>;
  withWorkspaceStorage<T>(workspaceId: string, options: { mode: "exclusive" | "shared"; purpose: string; create?: boolean }, operation: (context: WorkspaceRecoveryStorageContext) => Promise<T> | T): Promise<T>;
  dispose(): Promise<void>;
}

interface RecoveryTargetStates { sources?: Array<{path:string;target:RecoveryFileTarget}>; expected: RecoveryState; target: CombinedRecoveryTarget; resourcePath?: string; fileTarget?: RecoveryFileTarget }
type RecoveryTargets = Record<string, RecoveryTargetStates>;
type OperationFilePhase = "pending" | "apply-intent" | "target-observed" | "compensate-intent" | "safety-observed" | "needs-attention";
interface DurableFileRow { path: string; phase: OperationFilePhase; revision: number; safetyJson: string | null }
interface CombinedOperationRecord extends Record<string, unknown> {
  appliedPaths: string[];
  conversationState: WorkspaceCombinedRecoveryOperation["conversationState"];
  createdAt: string;
  editorImages?: WorkspaceCombinedRecoveryOperation["editorImages"];
  editorText?: string;
  failure: WorkspaceRecoveryFailure | null;
  fileState: WorkspaceCombinedRecoveryOperation["fileState"];
  id: string;
  navigationMarkerId: string | null;
  plan: WorkspaceCombinedRecoveryPlan;
  safety: Record<string, CombinedRecoverySafety>;
  state: WorkspaceCombinedRecoveryOperationState;
  targets: RecoveryTargets;
  updatedAt: string;
  workspaceId: string;
}
interface LocatedOperation { identity: RecoveryIdentity; record: CombinedOperationRecord; root: string }
interface SequencedRecoveryChange { physicalKey?: string; fileTarget?: RecoveryFileTarget; after: RecoveryState; before: RecoveryState; checkpointId: string; mutationId: string; path: string; sequence: number; toolName: string }

const TERMINAL_STATES = new Set(["complete", "aborted", "compensated", "needs-attention"]);
const revisionOf = (value: unknown): string => `sha256-${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new RecoveryPrimitiveError("storage-malformed", `${label} is malformed`, { origin: "storage" });
  return value;
};
const requireString = (value: unknown, label: string): string => {
  if (typeof value !== "string") throw new RecoveryPrimitiveError("storage-malformed", `${label} is malformed`, { origin: "storage" });
  return value;
};
const parseStateRecord = (value: unknown, label: string): Record<string, CombinedRecoverySafety> => Object.fromEntries(
  Object.entries(requireRecord(value, label)).map(([relativePath, state]) => [relativePath, parseCombinedSafety(state)]),
);
const parseTargets = (value: unknown): RecoveryTargets => Object.fromEntries(
  Object.entries(requireRecord(value, "Recovery operation targets")).map(([relativePath, raw]) => {
    const states = requireRecord(raw, `Recovery target ${relativePath}`);
    return [relativePath, { expected: parseRecoveryState(states.expected), target: parseCombinedTarget(states.target), ...(typeof states.resourcePath === "string" ? { resourcePath: states.resourcePath } : {}), ...(states.fileTarget ? { fileTarget: states.fileTarget as RecoveryFileTarget } : {}), ...(Array.isArray(states.sources) ? {sources:states.sources as Array<{path:string;target:RecoveryFileTarget}>} : {}) }];
  }),
);
const parseCombined = (operation: Record<string, unknown>): CombinedOperationRecord => {
  const raw = { ...(isRecord(operation.data) ? operation.data : {}), ...(isRecord(operation.result) ? operation.result : {}) };
  const plan = parseWorkspaceCombinedRecoveryPlan(raw.plan);
  const state = requireString(operation.state, "Recovery operation state") as WorkspaceCombinedRecoveryOperationState;
  const allowed: readonly WorkspaceCombinedRecoveryOperationState[] = ["planned", "applying-files", "files-restored", "navigating-conversation", "compensating-files", "compensated", "complete", "aborted", "needs-attention"];
  if (!allowed.includes(state)) throw new RecoveryPrimitiveError("storage-malformed", "Recovery operation state is malformed", { origin: "storage" });
  const id = requireString(operation.operationId, "Recovery operation id");
  const workspaceId = requireString(operation.workspaceId, "Recovery operation workspace");
  if (plan.id !== id || plan.workspaceId !== workspaceId) throw new RecoveryPrimitiveError("storage-malformed", "Recovery operation identity is inconsistent", { origin: "storage" });
  const conversationState = raw.conversationState;
  if (conversationState !== "unchanged" && conversationState !== "navigated" && conversationState !== "diverged") throw new RecoveryPrimitiveError("storage-malformed", "Recovery conversation state is malformed", { origin: "storage" });
  const fileState = raw.fileState;
  if (fileState !== "unchanged" && fileState !== "restored" && fileState !== "compensated" && fileState !== "needs-attention") throw new RecoveryPrimitiveError("storage-malformed", "Recovery file state is malformed", { origin: "storage" });
  const record: CombinedOperationRecord = {
    appliedPaths: Array.isArray(raw.appliedPaths) ? raw.appliedPaths.filter((item): item is string => typeof item === "string") : [],
    conversationState,
    createdAt: requireString(raw.createdAt ?? operation.createdAt, "Recovery operation creation time"),
    failure: raw.failure == null ? null : parseWorkspaceRecoveryFailure(raw.failure),
    fileState,
    id,
    navigationMarkerId: raw.navigationMarkerId == null ? null : requireString(raw.navigationMarkerId, "Recovery navigation marker"),
    plan,
    safety: parseStateRecord(raw.safety ?? {}, "Recovery safety states"),
    state,
    targets: parseTargets(raw.targets),
    updatedAt: requireString(raw.updatedAt ?? operation.updatedAt, "Recovery operation update time"),
    workspaceId,
    ...(Array.isArray(raw.editorImages) ? { editorImages: raw.editorImages as NonNullable<WorkspaceCombinedRecoveryOperation["editorImages"]> } : {}),
    ...(typeof raw.editorText === "string" ? { editorText: raw.editorText } : {}),
  };
  for (const value of Array.isArray(operation.files) ? operation.files : []) {
    if (!isRecord(value) || typeof value.path !== "string") continue;
    if (typeof value.safetyJson === "string") record.safety[value.path] = parseCombinedSafety(JSON.parse(value.safetyJson) as unknown);
    if ((value.phase === "target-observed" || value.phase === "compensate-intent") && !record.appliedPaths.includes(value.path)) record.appliedPaths.push(value.path);
  }
  return record;
};
const publicOperation = (record: CombinedOperationRecord): WorkspaceCombinedRecoveryOperation => ({
  affectedPathCount: record.plan.affectedPaths.length,
  appliedPathCount: record.appliedPaths.length,
  conversationState: record.conversationState,
  createdAt: record.createdAt,
  entryId: record.plan.entryId,
  expectedLeafId: record.plan.expectedLeafId,
  fileState: record.fileState,
  id: record.id,
  revision: record.plan.revision,
  conversation: record.plan.conversation,
  state: record.state,
  targetLeafId: record.plan.targetLeafId,
  updatedAt: record.updatedAt,
  workspaceId: record.plan.workspaceId,
  ...(record.editorImages ? { editorImages: record.editorImages } : {}),
  ...(record.editorText !== undefined ? { editorText: record.editorText } : {}),
  ...(record.failure ? { failure: record.failure } : {}),
  ...(record.navigationMarkerId ? { navigationMarkerId: record.navigationMarkerId } : {}),
  ...(record.plan.undoOf ? { undoOf: record.plan.undoOf } : {}),
});
const targetFor = (record: CombinedOperationRecord, relativePath: string): RecoveryTargetStates => {
  const value = record.targets[relativePath];
  if (!value) throw new RecoveryPrimitiveError("storage-malformed", `Recovery target is missing: ${relativePath}`, { origin: "storage" });
  return value;
};
const safetyFor = (record: CombinedOperationRecord, relativePath: string): RecoveryState => {
  const value = record.safety[relativePath];
  if (!value) throw new RecoveryPrimitiveError("storage-malformed", `Recovery safety state is missing: ${relativePath}`, { origin: "storage" });
  return value;
};
const mergeInverseTargets = (changes: SequencedRecoveryChange[]) => {
  const byPath = new Map<string, RecoveryTargetStates>();
  const chainConflicts = new Set<string>();
  for (const change of [...changes].sort((left, right) => left.sequence - right.sequence)) {
    const key = change.physicalKey ?? change.path;
    const current = byPath.get(key);
    if (!current) byPath.set(key, { expected: change.after, target: change.before, ...(change.fileTarget ? { resourcePath: change.path, fileTarget: change.fileTarget, sources:[{path:change.path,target:change.fileTarget}] } : {}) });
    else {
      if (!sameState(current.expected, change.before)) chainConflicts.add(key);
      current.expected = change.after;
      if (change.fileTarget) { current.resourcePath=change.path; current.fileTarget=change.fileTarget; (current.sources??=[]).push({path:change.path,target:change.fileTarget}); }
    }
  }
  return { byPath, chainConflicts: [...chainConflicts] };
};
const unavailable = (message: string): WorkspaceRecoveryFailedResult => ({
  status: "failed",
  failure: { code: "unavailable", message, origin: "storage", retryable: false },
});

export const createWorkspaceRecoveryEngine = (options: CreateWorkspaceRecoveryEngineOptions): WorkspaceRecoveryEngine => {
  const {
    authorityId,
    documents,
    durableRecoveryStore: durable,
    fileStore,
    sessionNavigation,
    resolveDirectoryApplyContext,
  } = options;
  const surfaceRecovery = createSurfaceRecovery(fileStore, documents.requestSurfaceOperation?.bind(documents));
  const queues = new Map<string, Promise<unknown>>();
  const inFlight = new Set<Promise<unknown>>();
  const startupFailures = new Map<string, WorkspaceRecoveryFailure[]>();
  let disposed = false;

  const track = <T>(callback: () => Promise<T> | T): Promise<T> => {
    if (disposed) return Promise.reject(new RecoveryPrimitiveError("unavailable", "Workspace recovery engine is disposed", { origin: "internal", retryable: true }));
    const current = Promise.resolve().then(callback);
    inFlight.add(current);
    void current.finally(() => inFlight.delete(current)).catch(() => undefined);
    return current;
  };

  const runSerialized = <T>(key: string, callback: () => Promise<T> | T): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      if (disposed) throw new RecoveryPrimitiveError("unavailable", "Workspace recovery engine is disposed", { origin: "internal", retryable: true });
      return callback();
    });
    queues.set(key, current);
    void current.finally(() => {
      if (queues.get(key) === current) queues.delete(key);
    }).catch(() => undefined);
    return current;
  };
  const runWorkspace = <T>(workspaceId: string, callback: () => Promise<T> | T) => runSerialized(`metadata\0${workspaceId}`, callback);
  const runOperation = <T>(operationId: string, callback: () => Promise<T> | T) => track(() => runSerialized(`operation\0${operationId}`, callback));
  const coordinateWorkspaceStorage: WorkspaceRecoveryEngine["coordinateWorkspaceStorage"] = (workspaceId, access, callback) => (
    access.mode === "shared" ? track(callback) : track(() => runWorkspace(workspaceId, callback))
  );
  const identityFor = async (workspaceId: string): Promise<RecoveryIdentity> => {
    const workspace = await documents.inspectWorkspace(workspaceId);
    return {
      authorityId,
      canonicalRoot: workspace.root,
      filesystemProfile: process.platform === "win32" ? "windows-local" : `${process.platform}-local`,
      workspaceId,
    };
  };
  const gateFor = (workspaceId: string): HostResourceOperationGate => ({
    run: (resources, callback) => documents.runResourceOperation
      ? documents.runResourceOperation(workspaceId, resources, callback)
      : callback(),
  });
  const dirtyBarrier = async (identity: RecoveryIdentity, paths: string[]): Promise<DirtyBarrierHandle> => {
    if (paths.length === 0) return { release: async () => undefined, settle: async () => undefined };
    if (!documents.beginDirtyStateBarrier) {
      throw new RecoveryPrimitiveError("dirty-state-unavailable", "Document surfaces do not support a dirty-state barrier", { origin: "conflict", retryable: true });
    }
    try {
      return await documents.beginDirtyStateBarrier(identity.workspaceId, paths, {
        caseSensitive: !identity.filesystemProfile.startsWith("windows"),
      });
    } catch (error) {
      throw new RecoveryPrimitiveError("dirty-state-unavailable", "Unsaved editor state could not be synchronized", { cause: error, origin: "conflict", retryable: true });
    }
  };
  const targetIdentity = (identity: RecoveryIdentity, target: RecoveryTargetStates): RecoveryIdentity => target.fileTarget?.kind === "physical"
    ? { ...identity, workspaceId: target.fileTarget.workspaceId, canonicalRoot: target.fileTarget.canonicalRoot, fileTarget: target.fileTarget } : identity;
  const adoptState = (source: string, destination: string, state: RecoveryState) => (fileStore as RecoveryFileStore & { adoptState?: (source: string, destination: string, state: RecoveryState) => Promise<void> }).adoptState?.(source,destination,state);
  const captureTarget = async (identity: RecoveryIdentity, targets: RecoveryTargets, key: string, store: boolean) => {
    const target = targets[key]!; const selected = targetIdentity(identity, target);
    const captured = await fileStore.captureState(selected, selected.canonicalRoot, target.resourcePath ?? key, { store });
    if (store) await adoptState(selected.workspaceId, identity.workspaceId, captured.state);
    return captured;
  };
  const applyTarget = async (identity: RecoveryIdentity, targets: RecoveryTargets, key: string, state: RecoveryState) => {
    const target = targets[key]!; const selected = targetIdentity(identity, target);
    await adoptState(identity.workspaceId,selected.workspaceId,state);
    return fileStore.applyState(selected, selected.canonicalRoot, target.resourcePath ?? key, parseRecoveryState(state));
  };
  const targetWorkspaces = async (identity: RecoveryIdentity, target: RecoveryTargetStates, key: string): Promise<Array<{workspaceId:string;path:string}>> => {
    const root = target.fileTarget?.kind === "physical" ? target.fileTarget.canonicalRoot : identity.canonicalRoot;
    const resource = target.resourcePath ?? key;
    const absolute = path.join(await canonicalizePathIdentity(path.dirname(path.join(root,resource)), {allowMissing:true}),path.basename(resource));
    const normalize = (value:string) => process.platform === "win32" ? value.toLowerCase() : value;
    const result: Array<{workspaceId:string;path:string}> = [];
    for (const registration of await documents.listWorkspaceRegistrations()) {
      // Stored canonical identities select only physically relevant owners; unrelated offline roots are not opened.
      const relative = path.relative(normalize(registration.canonicalPath),normalize(absolute));
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) continue;
      const current = await canonicalizePathIdentity(registration.canonicalPath);
      if (normalize(current) !== normalize(registration.canonicalPath)) throw new Error("Affected Documents root changed its physical identity");
      result.push({workspaceId:registration.workspaceId,path:normalizeResourceId(path.relative(current,absolute))});
    }
    return result.sort((a,b)=>a.workspaceId.localeCompare(b.workspaceId));
  };
  const targetBarrier = async (identity: RecoveryIdentity, targets: RecoveryTargets): Promise<TargetBarrierHandle> => {
    const groups = new Map<string, string[]>();
    for (const [key, target] of Object.entries(targets)) for (const owner of await targetWorkspaces(identity,target,key)) groups.set(owner.workspaceId,[...(groups.get(owner.workspaceId)??[]),owner.path]);
    const barriers: DirtyBarrierHandle[] = [];
    const byWorkspace = new Map<string, DirtyBarrierHandle>();
    try { for (const [workspaceId, paths] of [...groups].sort(([a],[b])=>a.localeCompare(b))) {
      const barrier = await dirtyBarrier({ ...identity, workspaceId }, paths);
      barriers.push(barrier); byWorkspace.set(workspaceId, barrier);
    } }
    catch (error) { await Promise.allSettled(barriers.map(value => value.release())); throw error; }
    return { release: async () => { await Promise.all(barriers.map(value => value.release())); }, settle: async () => { await Promise.all(barriers.map(value => value.settle())); },
      barrierFor(workspaceId) {
        const id = byWorkspace.get(workspaceId)?.barrierId;
        if (!id) throw new RecoveryPrimitiveError('dirty-state-unavailable', 'The affected editor recovery barrier is unavailable', { origin: 'conflict', retryable: true });
        return id;
      } };
  };
  const gateTarget = (identity: RecoveryIdentity, targets: RecoveryTargets, key: string): HostResourceOperationGate => ({ run: async (_resources, callback) => {
    const target = targets[key]!; const selected = targetIdentity(identity, target); const resource = { resourceId: target.resourcePath ?? key, scope: "subtree" as const };
    const kernelGate = (fileStore as RecoveryFileStore & { resourceOperationGate?: (identity: RecoveryIdentity) => HostResourceOperationGate }).resourceOperationGate?.(selected);
    const owners = await targetWorkspaces(identity,target,key);
    const apply = () => kernelGate ? kernelGate.run([resource], callback) : callback();
    const enter = (index:number):ReturnType<typeof apply> => index === owners.length ? apply() : gateFor(owners[index]!.workspaceId).run([{resourceId:owners[index]!.path,scope:"subtree"}],()=>enter(index+1));
    return enter(0);
  } });
  const conflictsFor = async (identity: RecoveryIdentity, root: string, targets: RecoveryTargets): Promise<WorkspaceRecoveryConflict[]> => {
    const key = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;
    const conflicts: WorkspaceRecoveryConflict[] = [];
    for (const [relativePath, states] of Object.entries(targets)) {
      try {
        const current = (await captureTarget(identity, targets, relativePath, false)).state;
        const surfaces = await targetWorkspaces(identity,states,relativePath);
        const owners = (await Promise.all(surfaces.map(async surface => {
          const publications = await documents.inspectDirtyBuffers(surface.workspaceId);
          return publications.flatMap(publication => publication.resources
            .filter(entry => key(normalizeResourceId(entry.resource.resourceId)) === key(surface.path))
            .map(entry => ({ workspaceId:surface.workspaceId, baseRevision:entry.baseRevision, generation:publication.generation,
              registrationId: publication.registrationId, documentInstanceId: entry.documentInstanceId, bufferHash: entry.bufferHash,
              encoding: entry.encoding, bom: entry.bom, lineEnding: entry.lineEnding,
              localEditRevision:entry.localEditRevision, ownerId:publication.ownerId })));
        }))).flat();
        if (owners.length > 0) {
          conflicts.push({
            fingerprint: revisionOf({ current: stateIdentity(current), owners, kind: "dirty-buffer", path: key(relativePath) }),
            kind: "dirty-buffer",
            message: "This file has unsaved editor changes",
            path: relativePath,
          });
        } else if (!sameState(current, states.expected)) {
          conflicts.push({
            fingerprint: revisionOf({ current: stateIdentity(current), expected: stateIdentity(states.expected), kind: "content-changed", path: key(relativePath) }),
            kind: "content-changed",
            message: "The file changed after this checkpoint",
            path: relativePath,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        conflicts.push({ fingerprint: revisionOf({ kind: "unsupported", message, path: key(relativePath) }), kind: "unsupported", message, path: relativePath });
      }
    }
    return conflicts;
  };
  const validateConflicts = (planned: WorkspaceRecoveryConflict[], current: WorkspaceRecoveryConflict[], input: WorkspaceCombinedRecoveryApplyInput): void => {
    const plannedByPath = new Map(planned.map((value) => [value.path, value]));
    const currentByPath = new Map(current.map((value) => [value.path, value]));
    if ([...planned, ...current].some((value) => value.kind === "unsupported")) {
      throw new RecoveryPrimitiveError("unsupported-metadata", "An affected path cannot be safely inspected", { origin: "conflict" });
    }
    if (input.conflictPolicy === "abort") {
      if (planned.length > 0 || current.length > 0) throw new RecoveryPrimitiveError("path-conflict", "Some affected files changed after the checkpoint", { origin: "conflict" });
      return;
    }
    const confirmed = new Map(input.confirmedConflicts.map((value) => [value.path, value]));
    if (confirmed.size !== input.confirmedConflicts.length) throw new RecoveryPrimitiveError("invalid-request", "Confirmed conflicts contain duplicate paths", { origin: "conflict" });
    const paths = new Set([...plannedByPath.keys(), ...currentByPath.keys(), ...confirmed.keys()]);
    const stale = [...paths].filter((relativePath) => {
      const before = plannedByPath.get(relativePath);
      const now = currentByPath.get(relativePath);
      const accepted = confirmed.get(relativePath);
      return !before || !now || !accepted || before.fingerprint !== accepted.fingerprint || now.fingerprint !== accepted.fingerprint;
    });
    if (stale.length > 0) throw new RecoveryPrimitiveError("stale-plan", "Affected files changed after conflict review", { details: { paths: stale }, origin: "conflict", retryable: true });
  };
  const getOperation = async (workspaceId: string, operationId: string): Promise<Record<string, unknown>> => {
    const operation = await durable.getOperation(workspaceId, operationId);
    if (!operation) throw new RecoveryPrimitiveError("operation-not-found", `Unknown recovery operation: ${operationId}`, { origin: "storage" });
    return operation;
  };
  const rowsFor = (operation: Record<string, unknown>): DurableFileRow[] => (Array.isArray(operation.files) ? operation.files : []).map((raw) => {
    const file = requireRecord(raw, "Recovery operation file");
    return {
      path: requireString(file.path, "Recovery operation path"),
      phase: requireString(file.phase, "Recovery operation file phase") as OperationFilePhase,
      revision: Number(file.revision ?? 1),
      safetyJson: typeof file.safetyJson === "string" ? file.safetyJson : null,
    };
  });
  const transitionFile = async (
    record: CombinedOperationRecord,
    relativePath: string,
    phase: OperationFilePhase,
    states: { expected?: RecoveryState; target?: RecoveryState; safety?: RecoveryState } = {},
  ): Promise<void> => {
    const file = rowsFor(await getOperation(record.plan.workspaceId, record.id)).find((value) => value.path === relativePath);
    if (!file) throw new RecoveryPrimitiveError("storage-malformed", `Recovery operation path is missing: ${relativePath}`, { origin: "storage" });
    if (file.phase === phase && Object.keys(states).length === 0) return;
    await durable.updateOperationFile({
      operationId: record.id,
      workspaceId: record.plan.workspaceId,
      path: relativePath,
      expectedRevision: file.revision,
      expectedPhase: file.phase,
      phase,
      ...states,
      ...(record.plan.conversation.kind === "pi" ? { sessionId: record.plan.conversation.sessionId } : { threadId: record.plan.conversation.threadId }),
    });
  };
  const persist = async (record: CombinedOperationRecord): Promise<void> => {
    record.updatedAt = new Date().toISOString();
    const operation = await getOperation(record.plan.workspaceId, record.id);
    await durable.completeOperation({
      operationId: record.id,
      workspaceId: record.plan.workspaceId,
      expectedRevision: Number(operation.revision ?? 1),
      state: record.state,
      result: record,
      ...(record.failure ? { failure: record.failure as unknown as Record<string, unknown> } : {}),
      ...(record.plan.conversation.kind === "pi" ? { sessionId: record.plan.conversation.sessionId } : { threadId: record.plan.conversation.threadId }),
    });
  };
  const createCombined = (record: CombinedOperationRecord) => durable.createOperation({
    operationId: record.id,
    workspaceId: record.plan.workspaceId,
    kind: "combined",
    state: record.state,
    data: record,
    targets: record.targets,
    ...(record.plan.conversation.kind === "pi" ? { sessionId: record.plan.conversation.sessionId } : { threadId: record.plan.conversation.threadId }),
  });
  const prepareSurfaceSafety = async (identity: RecoveryIdentity, record: CombinedOperationRecord, key: string, barrier: TargetBarrierHandle) => {
    const target = record.targets[key]!;
    const desired = new Map((target.target.surfaceTargets ?? []).map(value => [surfaceOwnerKey(value), value]));
    const candidates = new Map<string, { owner: RecoverySurfaceOwner; binding: DocumentSurfaceBinding }>();
    for (const surface of await targetWorkspaces(identity, target, key)) {
      for (const publication of await documents.inspectDirtyBuffers(surface.workspaceId)) {
        for (const entry of publication.resources) {
          const same = process.platform === 'win32' ? entry.resource.resourceId.toLowerCase() === surface.path.toLowerCase() : entry.resource.resourceId === surface.path;
          if (!same) continue;
          if (!publication.registrationId || !entry.documentInstanceId || !entry.bufferHash || entry.encoding !== 'utf-8'
            || typeof entry.bom !== 'boolean' || !entry.lineEnding) {
            throw new RecoveryPrimitiveError('dirty-state-unavailable', 'The affected editor owner has no complete recovery binding', { origin: 'conflict', retryable: true });
          }
          const owner = { ownerId: publication.ownerId, generation: publication.generation,
            registrationId: publication.registrationId, workspaceId: publication.workspaceId };
          const binding: DocumentSurfaceBinding = { ...entry, resource: { ...entry.resource, workspaceId: publication.workspaceId },
            documentInstanceId: entry.documentInstanceId, bufferHash: entry.bufferHash, encoding: entry.encoding,
            bom: entry.bom, lineEnding: entry.lineEnding };
          candidates.set(surfaceOwnerKey({ ...owner, binding }), { owner, binding });
        }
      }
    }
    // Undo must restore the original draft even when the forward recovery made
    // that document clean, so it may no longer appear in dirty publications.
    for (const [ownerKey, original] of desired) if (!candidates.has(ownerKey)) {
      candidates.set(ownerKey, { owner: original, binding: original.binding });
    }
    if (!candidates.size) return;
    const safety = record.safety[key]!;
    safety.surfaces = [];
    for (const [ownerKey, candidate] of candidates) {
      const prepared = await surfaceRecovery.prepare(identity, record.id, barrier.barrierFor(candidate.owner.workspaceId),
        candidate.owner, candidate.binding, target.target, desired.get(ownerKey)?.text);
      try {
        safety.surfaces.push(prepared.safety);
        await transitionFile(record, key, 'apply-intent', { safety });
      } finally { await prepared.release(); }
    }
  };
  const saveSurfaceSafety = async (record: CombinedOperationRecord, key: string) => {
    const row = rowsFor(await getOperation(record.workspaceId, record.id)).find(value => value.path === key);
    if (!row) throw new RecoveryPrimitiveError('storage-malformed', 'Editor recovery path has no journal row', { origin: 'storage' });
    await transitionFile(record, key, row.phase, { safety: record.safety[key]! });
  };
  const findCombined = async (operationId: string): Promise<CombinedOperationRecord> => {
    let inspectionFailure: unknown;
    for (const registration of await documents.listWorkspaceRegistrations()) {
      try {
        const stored = await durable.getOperation(registration.workspaceId, operationId);
        if (!stored || stored.kind !== "combined") continue;
        return parseCombined(stored);
      } catch (error) {
        inspectionFailure ??= error;
      }
    }
    if (inspectionFailure) throw new RecoveryPrimitiveError("storage-malformed", "Recovery operation lookup could not inspect every workspace", { cause: inspectionFailure, origin: "storage" });
    throw new RecoveryPrimitiveError("operation-not-found", `Unknown recovery operation: ${operationId}`, { origin: "storage" });
  };

  const locate = async (operationId: string): Promise<LocatedOperation> => {
    const record = await findCombined(operationId);
    const identity = await identityFor(record.workspaceId);
    return { identity, record, root: identity.canonicalRoot };
  };
  const physicalKey = async (target: RecoveryFileTarget | undefined, resource: string): Promise<string> => {
    if (target?.kind !== "physical") return resource;
    const full = path.join(await canonicalizePathIdentity(path.dirname(path.join(target.canonicalRoot, resource)), {allowMissing:true}), path.basename(resource));
    return `files/${revisionOf(process.platform === "win32" ? full.toLowerCase() : full)}`;
  };

  const changesFor = async (workspaceId: string, conversation: RecoveryConversation, entryIds: string[], journalTurns?: NavigationPrepared["journalTurns"]) => {
    if (entryIds.length === 0) return { changes: [] as SequencedRecoveryChange[], incomplete: false, uncoveredPaths: [] as WorkspaceRecoveryUncoveredPath[], uncoveredReasons: [] as string[], uncoveredFiles: {} as NonNullable<WorkspaceCombinedRecoveryPlan["fileTargets"]> };
    if (!durable.listChanges) throw new RecoveryPrimitiveError("unavailable", "Rust recovery change reader is unavailable", { origin: "storage" });
    const selections = journalTurns ? await Promise.all(journalTurns.map(async turn => ({ turn, value: await durable.listChanges!({ workspaceId: turn.workspaceId, executionId: turn.executionId }) }))) : [{ turn: {workspaceId,restore:true}, value: await durable.listChanges({workspaceId,conversation,entryIds}) }];
    const partialTurn = selections.some(({turn,value}) => !turn.restore && (value.changes.length > 0 || value.turns.some(item => item.status !== "ready")));
    const selected = { changes: selections.flatMap(({turn,value}, index) => turn.restore ? value.changes.map(change => ({...change, sequence:index})) : []), turns: selections.flatMap(({value}) => value.turns) };
    for (const {turn,value} of selections) if (turn.restore) for (const change of value.changes) { await adoptState(turn.workspaceId,workspaceId,change.before); await adoptState(turn.workspaceId,workspaceId,change.after); }
    const changes = selected.changes.filter((value) => !sameState(value.before, value.after)).map((value) => ({
      after: parseRecoveryState(value.after),
      before: parseRecoveryState(value.before),
      checkpointId: value.checkpointId,
      mutationId: value.mutationId,
      path: value.path,
      sequence: value.sequence,
      toolName: value.toolName,
      ...(value.fileTarget ? { fileTarget: value.fileTarget } : {}),
    }));
    const uncovered = new Map<string, WorkspaceRecoveryUncoveredPath>();
    const uncoveredFiles: NonNullable<WorkspaceCombinedRecoveryPlan["fileTargets"]> = {};
    const reasons = new Set<string>(partialTurn ? ["The selected entry is inside an input checkpoint; its remaining file effects cannot be separated from retained effects"] : []);
    for (const turn of selected.turns.filter((value) => value.status !== "ready")) {
      const source: WorkspaceRecoveryUncoveredPath["source"] = turn.activeWriterScopes.some((scope) => scope.startsWith("process/"))
        ? "shell"
        : turn.activeWriterScopes.some((scope) => scope.startsWith("external/")) ? "external" : "unknown";
      for (const relativePath of turn.unrecordedResourceIds) {
        const key = await physicalKey(turn.fileTarget, relativePath);
        if (!uncovered.has(key)) uncovered.set(key, { path: key, source });
        uncoveredFiles[key] = {path:relativePath,target:turn.fileTarget ?? {kind:"workspace"}};
      }
      if (typeof turn.failure?.message === "string" && turn.failure.message) reasons.add(turn.failure.message);
    }
    return {
      changes,
      uncoveredFiles,
      incomplete: partialTurn || selected.turns.some((value) => value.status !== "ready"),
      uncoveredPaths: [...uncovered.values()].sort((left, right) => left.path.localeCompare(right.path)),
      uncoveredReasons: [...reasons].sort(),
    };
  };
  const prepareCombined = async (input: WorkspaceCombinedRecoveryPrepareInput): Promise<WorkspaceCombinedRecoveryPlan> => {
    const identity = await identityFor(input.workspaceId);
    const navigation = await sessionNavigation.prepare(input);
    const binding = await durable.resolveEntry(input);
    if (input.conversation.kind === "pi" && binding.status !== "ready") throw new RecoveryPrimitiveError("checkpoint-incomplete", "The selected conversation entry has no ready checkpoint", { origin: "coverage" });
    const removedEntryIds = [...new Set(navigation.removedEntryIds ?? [])];
    const loaded = await changesFor(input.workspaceId, input.conversation, removedEntryIds, navigation.journalTurns);
    for (const change of loaded.changes) if (change.fileTarget?.kind === "physical") {
      const target = change.fileTarget;
      await fileStore.captureState({...identity,workspaceId:target.workspaceId,canonicalRoot:target.canonicalRoot,fileTarget:target},target.canonicalRoot,change.path,{store:false});
      (change as SequencedRecoveryChange).physicalKey = await physicalKey(target, change.path);
    }
    const merged = mergeInverseTargets(loaded.changes);
    const targets = Object.fromEntries(merged.byPath);
    const barrier = await targetBarrier(identity, targets);
    let conflicts: WorkspaceRecoveryConflict[];
    try {
      conflicts = await conflictsFor(identity, identity.canonicalRoot, targets);
    } finally {
      await barrier.release();
    }
    for (const id of Object.keys(targets)) if (loaded.uncoveredPaths.some(value => value.path === id)) conflicts.push({fingerprint:revisionOf({kind:"incomplete-chain",path:id}),kind:"unsupported",path:id,message:"A controlled file history contains an external or unrecorded change"});
    for (const relativePath of merged.chainConflicts) {
      conflicts.push({ fingerprint: revisionOf({ kind: "chain-conflict", path: relativePath }), kind: "unsupported", message: "Recorded file history is not contiguous", path: relativePath });
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const affectedPaths = Object.keys(targets).sort();
    const gap = loaded.incomplete || loaded.uncoveredPaths.length > 0;
    const coverage: WorkspaceCombinedRecoveryCoverage = !gap ? "ready" : affectedPaths.length > 0 ? "partial" : "none";
    const draft: Omit<WorkspaceCombinedRecoveryPlan, "revision"> = {
      affectedPaths,
      fileTargets: {...loaded.uncoveredFiles, ...Object.fromEntries(Object.entries(targets).map(([key, target]) => [key, { path: target.resourcePath ?? key, target: target.fileTarget ?? { kind: "workspace" as const } }]))},
      changedBytes: Object.values(targets).reduce((sum, value) => sum + Math.max(value.expected.kind === "regular-file" ? value.expected.byteLength : 0, value.target.kind === "regular-file" ? value.target.byteLength : 0), 0),
      conflicts,
      coverage,
      createdAt,
      entryId: input.entryId,
      expectedLeafId: navigation.expectedLeafId,
      id,
      removedEntryIds,
      conversation: input.conversation,
      targetLeafId: navigation.targetLeafId,
      uncoveredPaths: loaded.uncoveredPaths,
      uncoveredReasons: loaded.uncoveredReasons,
      workspaceId: input.workspaceId,
    };
    const plan = { ...draft, revision: revisionOf(draft) };
    await createCombined({
      appliedPaths: [],
      conversationState: "unchanged",
      createdAt,
      failure: null,
      fileState: "unchanged",
      id,
      navigationMarkerId: null,
      plan,
      safety: {},
      state: "planned",
      targets,
      updatedAt: createdAt,
      workspaceId: input.workspaceId,
      ...(navigation.editorImages ? { editorImages: navigation.editorImages } : {}),
      ...(navigation.editorText !== undefined ? { editorText: navigation.editorText } : {}),
    });
    return plan;
  };
  const compensate = async (record: CombinedOperationRecord, identity: RecoveryIdentity, _root: string, barrier: TargetBarrierHandle): Promise<void> => {
    record.state = "compensating-files";
    await persist(record);
    for (const row of rowsFor(await getOperation(record.plan.workspaceId, record.id)).reverse()) {
      if (row.phase === "safety-observed" || row.phase === "pending") continue;
      if (row.phase === "needs-attention") throw new RecoveryPrimitiveError("needs-attention", `File ${row.path} is in needs-attention state and blocks compensation`, { origin: "storage" });
      if (row.phase !== "target-observed" && row.phase !== "compensate-intent" && row.phase !== 'apply-intent') continue;
      await gateTarget(identity, record.targets, row.path).run([{ resourceId: row.path, scope: "subtree" }], async () => {
        await barrier.settle();
        const current = (await captureTarget(identity, record.targets, row.path, false)).state;
        const atSafety = sameState(current, safetyFor(record, row.path));
        if (!atSafety && !sameState(current, targetFor(record, row.path).target)) {
          await transitionFile(record, row.path, "needs-attention");
          throw new RecoveryPrimitiveError("needs-attention", `Cannot compensate a file changed after recovery: ${row.path}`, { origin: "storage" });
        }
        if (row.phase !== "compensate-intent") await transitionFile(record, row.path, "compensate-intent");
        for (const surface of record.safety[row.path]?.surfaces ?? []) {
          await surfaceRecovery.replace(identity, record.id, barrier.barrierFor(surface.workspaceId), surface,
            'compensate', () => saveSurfaceSafety(record, row.path));
        }
        if (!atSafety) await applyTarget(identity, record.targets, row.path, safetyFor(record, row.path));
        const restored = (await captureTarget(identity, record.targets, row.path, false)).state;
        if (!sameState(restored, safetyFor(record, row.path))) {
          await transitionFile(record, row.path, "needs-attention");
          throw new RecoveryPrimitiveError("needs-attention", `Compensated file did not match safety state: ${row.path}`, { origin: "storage" });
        }
        await transitionFile(record, row.path, "safety-observed");
      });
    }
    record.fileState = "compensated";
    record.state = "compensated";
    await persist(record);
  };
  const navigate = async (record: CombinedOperationRecord): Promise<void> => {
    const committed = record.plan.undoOf
      ? await sessionNavigation.commitLeaf({ expectedLeafId: record.plan.expectedLeafId, operationId: record.id, preparedTargetLeafId: record.plan.targetLeafId, conversation: record.plan.conversation, ...(record.plan.undoOf ? { undoOf: record.plan.undoOf } : {}), workspaceId: record.plan.workspaceId })
      : await sessionNavigation.commit({ entryId: record.plan.entryId, expectedLeafId: record.plan.expectedLeafId, operationId: record.id, preparedTargetLeafId: record.plan.targetLeafId, conversation: record.plan.conversation, ...(record.plan.undoOf ? { undoOf: record.plan.undoOf } : {}), workspaceId: record.plan.workspaceId });
    record.conversationState = "navigated";
    if (committed.editorImages !== undefined) record.editorImages = committed.editorImages;
    if (committed.editorText !== undefined) record.editorText = committed.editorText;
    record.navigationMarkerId = committed.markerId ?? committed.navigationMarkerId ?? null;
  };
  const applyCombined = async (located: LocatedOperation, input: WorkspaceCombinedRecoveryApplyInput): Promise<WorkspaceCombinedRecoveryOperation> => {
    const { identity, root } = located;
    const record = parseCombined(await getOperation(identity.workspaceId, input.operationId));
    let barrier: TargetBarrierHandle | undefined;
    try {
      if (record.plan.revision !== input.expectedRevision) throw new RecoveryPrimitiveError("stale-plan", "Recovery plan changed before it was applied", { origin: "conflict", retryable: true });
      if (TERMINAL_STATES.has(record.state)) return publicOperation(record);
      if (record.state !== "planned") { await reconcileCombined(identity.workspaceId, identity, await getOperation(identity.workspaceId, record.id)); return publicOperation(parseCombined(await getOperation(identity.workspaceId, record.id))); }
      if (record.plan.coverage === "none") throw new RecoveryPrimitiveError("checkpoint-incomplete", "This conversation range has no restorable file paths", { origin: "coverage" });
      barrier = await targetBarrier(identity, record.targets);
      validateConflicts(record.plan.conflicts, await conflictsFor(identity, root, record.targets), input);
      if (record.state === "planned") {
        for (const relativePath of Object.keys(record.targets)) {
          const safety = (await captureTarget(identity, record.targets, relativePath, true)).state;
          record.safety[relativePath] = safety;
          await transitionFile(record, relativePath, "apply-intent", { safety });
          await prepareSurfaceSafety(identity, record, relativePath, barrier);
        }
        await barrier.settle();
        validateConflicts(record.plan.conflicts, await conflictsFor(identity, root, record.targets), input);
        record.state = "applying-files";
        await persist(record);
      }
      await barrier.settle();
      try {
        for (const row of rowsFor(await getOperation(identity.workspaceId, record.id))) {
          if (row.phase === "needs-attention") throw new RecoveryPrimitiveError("needs-attention", `File ${row.path} is in needs-attention state and blocks recovery`, { origin: "storage" });
          if (row.phase === "target-observed") {
            if (!record.appliedPaths.includes(row.path)) record.appliedPaths.push(row.path);
            continue;
          }
          if (row.phase === "safety-observed" || (row.phase !== "apply-intent" && row.phase !== "pending")) continue;
          await barrier.settle();
          await gateTarget(identity, record.targets, row.path).run([{ resourceId: row.path, scope: "subtree" }], async () => {
            const current = (await captureTarget(identity, record.targets, row.path, false)).state;
            if (!sameState(current, safetyFor(record, row.path))) {
              await transitionFile(record, row.path, "needs-attention");
              throw new RecoveryPrimitiveError("stale-plan", `File changed after safety capture: ${row.path}`, { details: { paths: [row.path] }, origin: "conflict", retryable: true });
            }
            await applyTarget(identity, record.targets, row.path, targetFor(record, row.path).target);
            const verified = (await captureTarget(identity, record.targets, row.path, false)).state;
            if (!sameState(verified, targetFor(record, row.path).target)) {
              await transitionFile(record, row.path, "needs-attention");
              throw new RecoveryPrimitiveError("needs-attention", `Restored file did not match its checkpoint: ${row.path}`, { origin: "storage" });
            }
            if (!record.appliedPaths.includes(row.path)) record.appliedPaths.push(row.path);
            for (const surface of record.safety[row.path]?.surfaces ?? []) {
              await surfaceRecovery.replace(identity, record.id, barrier!.barrierFor(surface.workspaceId), surface,
                'apply', () => saveSurfaceSafety(record, row.path));
            }
            await transitionFile(record, row.path, "target-observed");
          });
          if (!record.appliedPaths.includes(row.path)) record.appliedPaths.push(row.path);
          await persist(record);
        }
        record.fileState = record.plan.affectedPaths.length > 0 ? "restored" : "unchanged";
        record.state = "files-restored";
        await persist(record);
      } catch (error) {
        if (record.appliedPaths.length > 0) {
          try {
            await compensate(record, identity, root, barrier);
          } catch (compensationError) {
            record.failure = recoveryFailure(compensationError, "needs-attention");
            record.fileState = "needs-attention";
            record.state = "needs-attention";
            await persist(record);
            throw compensationError;
          }
        }
        if (rowsFor(await getOperation(identity.workspaceId, record.id)).some((row) => row.phase === "needs-attention")) {
          record.failure = recoveryFailure(error, "needs-attention");
          record.fileState = "needs-attention";
          record.state = "needs-attention";
          await persist(record);
        }
        throw error;
      }
      record.state = "navigating-conversation";
      await persist(record);
      try {
        await navigate(record);
      } catch (error) {
        record.failure = recoveryFailure(error, "navigation-conflict");
        if (error instanceof RecoveryPrimitiveError && error.code === "navigation-conflict" && !error.retryable) { await compensate(record, identity, root, barrier); throw error; }
        record.state = "navigating-conversation";
        await persist(record);
        throw new RecoveryPrimitiveError("navigation-conflict", error instanceof Error ? error.message : "Conversation navigation failed", { cause: error, operationId: record.id, origin: "navigation" });
      }
      record.failure = null;
      record.state = "complete";
      await persist(record);
      return publicOperation(record);
    } finally {
      await barrier?.release();
    }
  };

  const prepareUndo = async (operationId: string): Promise<WorkspaceCombinedRecoveryPlan> => {
    const located = await locate(operationId);
    const original = parseCombined(await getOperation(located.identity.workspaceId, operationId));
    if (original.state !== "complete") throw new RecoveryPrimitiveError("recovery-in-progress", "Only a completed recovery can be undone");
    const navigation = await sessionNavigation.prepareLeaf({ conversation: original.plan.conversation, undoOf: original.id, targetLeafId: original.plan.expectedLeafId, workspaceId: original.plan.workspaceId });
    const targets: RecoveryTargets = {};
    for (const relativePath of original.plan.affectedPaths) {
      const originalStates = targetFor(original, relativePath);
      const surfaces = original.safety[relativePath]?.surfaces ?? [];
      const surfaceTargets: RecoverySurfaceTarget[] = surfaces.map(surface => {
        if (surface.phase !== 'applied' || !surface.appliedBinding) throw new RecoveryPrimitiveError('needs-attention', 'The original editor restore is not confirmed', { origin: 'storage' });
        return { ownerId: surface.ownerId, generation: surface.generation, registrationId: surface.registrationId,
          workspaceId: surface.workspaceId, binding: surface.appliedBinding, text: surface.text };
      });
      targets[relativePath] = { ...originalStates, expected: parseRecoveryState(originalStates.target),
        target: { ...parseRecoveryState(safetyFor(original, relativePath)), ...(surfaceTargets.length ? { surfaceTargets } : {}) } };
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const barrier = await targetBarrier(located.identity, targets);
    let conflicts: WorkspaceRecoveryConflict[];
    try {
      conflicts = await conflictsFor(located.identity, located.root, targets);
    } finally {
      await barrier.release();
    }
    const draft: Omit<WorkspaceCombinedRecoveryPlan, "revision"> = {
      affectedPaths: Object.keys(targets).sort(),
      ...(original.plan.fileTargets ? { fileTargets: original.plan.fileTargets } : {}),
      changedBytes: Object.values(targets).reduce((sum, value) => sum + Math.max(value.expected.kind === "regular-file" ? value.expected.byteLength : 0, value.target.kind === "regular-file" ? value.target.byteLength : 0), 0),
      conflicts,
      coverage: "ready",
      createdAt,
      entryId: original.plan.entryId,
      expectedLeafId: navigation.expectedLeafId,
      id,
      removedEntryIds: [],
      conversation: original.plan.conversation,
      targetLeafId: navigation.targetLeafId,
      uncoveredPaths: [],
      uncoveredReasons: [],
      undoOf: original.id,
      workspaceId: original.plan.workspaceId,
    };
    const plan = { ...draft, revision: revisionOf(draft) };
    await createCombined({
      appliedPaths: [],
      conversationState: "unchanged",
      createdAt,
      failure: null,
      fileState: "unchanged",
      id,
      navigationMarkerId: null,
      plan,
      safety: {},
      state: "planned",
      targets,
      updatedAt: createdAt,
      workspaceId: original.plan.workspaceId,
    });
    return plan;
  };

  const reconcileCombined = async (workspaceId: string, identity: RecoveryIdentity, stored: Record<string, unknown>): Promise<WorkspaceCombinedRecoveryOperation | null> => {
    const record = parseCombined(stored);
    if (record.state === "planned" || TERMINAL_STATES.has(record.state)) return null;
    let barrier: TargetBarrierHandle | undefined;
    try {
      barrier = await targetBarrier(identity, record.targets);
      if (record.state === "files-restored" || record.state === "navigating-conversation") {
        const rows = rowsFor(stored);
        if (rows.some((row) => row.phase !== "target-observed" && row.phase !== "safety-observed")) {
          throw new RecoveryPrimitiveError("needs-attention", "Conversation recovery reached navigation with unresolved file phases", { origin: "storage" });
        }
        if (Object.values(record.safety).some(safety => safety.surfaces?.some(surface => surface.phase !== 'applied'))) {
          throw new RecoveryPrimitiveError('needs-attention', 'Conversation recovery has an unconfirmed editor restore', { origin: 'storage' });
        }
        if (record.state === "files-restored") {
          record.state = "navigating-conversation";
          await persist(record);
        }
        try { await navigate(record); } catch (error) {
          if (error instanceof RecoveryPrimitiveError && error.code === "navigation-conflict" && !error.retryable) { record.failure = recoveryFailure(error); await compensate(record, identity, identity.canonicalRoot, barrier); return publicOperation(record); }
          throw error;
        }
        record.failure = null;
        record.fileState = record.plan.affectedPaths.length > 0 ? "restored" : "unchanged";
        record.state = "complete";
        await persist(record);
        return publicOperation(record);
      }
      const phases: OperationFilePhase[] = [];
      for (const row of rowsFor(stored)) {
        let phase = row.phase;
        for (const surface of record.safety[row.path]?.surfaces ?? []) {
          await surfaceRecovery.observe(record.id, barrier.barrierFor(surface.workspaceId), surface);
        }
        if (record.safety[row.path]?.surfaces?.length) await saveSurfaceSafety(record, row.path);
        const surfaceApplied = record.safety[row.path]?.surfaces?.some(surface => surface.phase === 'applied') ?? false;
        if (row.phase === "apply-intent" || row.phase === "compensate-intent") {
          const current = (await captureTarget(identity, record.targets, row.path, false)).state;
          if (row.phase === "apply-intent") {
            if (sameState(current, targetFor(record, row.path).target) || (surfaceApplied && sameState(current, safetyFor(record, row.path)))) {
              await transitionFile(record, row.path, "target-observed");
              phase = "target-observed";
              if (!record.appliedPaths.includes(row.path)) record.appliedPaths.push(row.path);
            } else if (!sameState(current, safetyFor(record, row.path))) {
              await transitionFile(record, row.path, "needs-attention");
              phase = "needs-attention";
            }
          } else if (sameState(current, safetyFor(record, row.path)) && !surfaceApplied) {
            await transitionFile(record, row.path, "safety-observed");
            phase = "safety-observed";
          } else if (!sameState(current, targetFor(record, row.path).target) && !sameState(current, safetyFor(record, row.path))) {
            await transitionFile(record, row.path, "needs-attention");
            phase = "needs-attention";
          }
        }
        phases.push(phase);
      }
      if (phases.includes("needs-attention")) {
        record.failure = recoveryFailure(new RecoveryPrimitiveError("needs-attention", "Operation has files in an unreconcilable state after crash", { origin: "storage" }), "needs-attention");
        record.fileState = "needs-attention";
        record.state = "needs-attention";
        await persist(record);
      } else if (phases.includes("compensate-intent") || phases.includes("target-observed")) {
        await compensate(record, identity, identity.canonicalRoot, barrier);
      } else if (phases.includes("safety-observed")) {
        record.fileState = "compensated";
        record.state = "compensated";
        await persist(record);
      } else {
        record.state = "aborted";
        await persist(record);
      }
    } catch (error) {
      record.failure = recoveryFailure(error, "needs-attention");
      if (error instanceof RecoveryPrimitiveError && error.code === "navigation-conflict" && error.retryable) { record.state = "navigating-conversation"; }
      else { record.fileState = "needs-attention"; record.state = "needs-attention"; }
      await persist(record).catch(() => undefined);
    } finally {
      await barrier?.release();
    }
    return publicOperation(record);
  };

  const resume = async (): Promise<WorkspaceCombinedRecoveryOperation[]> => {
    const output: WorkspaceCombinedRecoveryOperation[] = [];
    for (const registration of await documents.listWorkspaceRegistrations()) {
      await track(() => runSerialized(`resume\0${registration.workspaceId}`, async () => {
        const identity = await identityFor(registration.workspaceId);
        for (const summary of await durable.listOperations(registration.workspaceId, "combined")) {
          if (TERMINAL_STATES.has(String(summary.state)) || summary.state === "planned") continue;
          const candidate = await durable.getOperation(registration.workspaceId, requireString(summary.operationId, "Recovery operation id"));
          if (candidate && sessionNavigation.ready?.(parseCombined(candidate).plan.conversation) === false) continue;
          const operationId = requireString(summary.operationId, "Recovery operation id");
          const reconciled = await runOperation(operationId, async () => reconcileCombined(registration.workspaceId, identity,
            await getOperation(registration.workspaceId, operationId)));
          if (reconciled) output.push(reconciled);
        }
        const context: DurableFileOperationContext = {
          durableRecoveryStore: durable,
          fileStore,
          identity,
          resourceOperationGate: gateFor(registration.workspaceId),
          root: identity.canonicalRoot,
          ...(resolveDirectoryApplyContext ? { resolveDirectoryApplyContext } : {}),
        };
        await reconcileInterruptedIntegrationOperations(context);
        const { reconcileInterruptedAgentMutations } = await import("../documents/agent-mutation-operation.js");
        const mutations = await reconcileInterruptedAgentMutations(context);
        if (mutations.needsAttention.length > 0) {
          const failures = startupFailures.get(registration.workspaceId) ?? [];
          failures.push(recoveryFailure(new RecoveryPrimitiveError("needs-attention", `Agent surface mutation recovery requires attention (${mutations.needsAttention.join(", ")})`, { operationId: mutations.needsAttention[0], origin: "storage" }), "needs-attention"));
          startupFailures.set(registration.workspaceId, failures);
        }
      })).catch((error) => {
        const failures = startupFailures.get(registration.workspaceId) ?? [];
        failures.push(recoveryFailure(error, "needs-attention"));
        startupFailures.set(registration.workspaceId, failures);
      });
    }
    return output;
  };
  const safe = async <T>(callback: () => Promise<T>, code: WorkspaceRecoveryFailureCode = "internal"): Promise<T | WorkspaceRecoveryFailedResult> => {
    try { return await callback(); } catch (error) { return failedRecoveryResult(error, code); }
  };
  const storage = async (workspaceId?: string) => {
    const [health, checkpoints] = await Promise.all([
      durable.health?.() ?? Promise.resolve({}),
      workspaceId ? durable.listCheckpoints(workspaceId) : Promise.resolve([]),
    ]) as [{ catalogBytes?: number; walBytes?: number; blobs?: number }, WorkspaceRecoveryCheckpointSummary[]];
    return {
      authorityId,
      scope: "host" as const,
      byteLength: Number(health.catalogBytes ?? 0) + Number(health.walBytes ?? 0),
      catalog: { currentSchemaVersion: 1, retiredCatalogCount: 0, state: "ready" as const },
      checkpointCount: checkpoints.length,
      encryption: { available: false, enabled: false },
      location: { mode: "application-data" as const },
      locationSource: "global" as const,
      objectCount: Number(health.blobs ?? 0),
      readyCheckpointCount: checkpoints.filter((value) => value.state === "ready").length,
      registryRevision: 1,
      state: "ready" as const,
      ...(workspaceId ? { workspaceId } : {}),
    };
  };
  const retention = async (workspaceId: string) => ({
    eligibleCheckpointCount: 0,
    lastRunAt: null,
    oldestProtectedOperationAt: null,
    policy: { maxAgeDays: null, maxByteLength: null, maxCheckpointCount: null, maxOperationCount: null },
    protectedCheckpointCount: (await durable.listCheckpoints(workspaceId)).length,
    protectedOperationCount: (await durable.listOperations(workspaceId)).length,
    retainedByteLength: 0,
    terminalOperationCount: (await durable.listOperations(workspaceId)).filter((value) => ["complete", "aborted", "compensated", "undone"].includes(String(value.state))).length,
    workspaceId,
  });

  return {
    applyCombinedRecovery: (input) => safe(async () => {
      const located = await locate(input.operationId);
      return { operation: await runOperation(input.operationId, () => applyCombined(located, input)), status: "ready" };
    }),
    cancelCombinedOperation: (operationId) => safe(async () => {
      const located = await locate(operationId);
      return runOperation(operationId, async () => {
        const record = parseCombined(await getOperation(located.identity.workspaceId, operationId));
        if (record.state === "planned") {
          record.state = "aborted";
          await persist(record);
        }
        return { operation: publicOperation(record), status: "ready" as const };
      });
    }),
    clearStorageLocationOverride: async () => unavailable("Rust recovery storage has no workspace location override"),
    cleanupStorage: (input) => safe(async () => {
      if (!durable.collectUnreachableObjects) return unavailable("Kernel object cleanup is unavailable");
      const collected = await durable.collectUnreachableObjects(input.workspaceId);
      return {
        status: "ready",
        result: {
          ...collected,
          failures: [],
          operationId: `kernel-recovery-gc:${input.workspaceId}:${randomUUID()}`,
          recordsDeleted: 0,
          status: "complete",
          workspaceId: input.workspaceId,
        },
      };
    }),
    createCheckpoint: (input) => safe(async () => ({ checkpoint: await durable.createNamedCheckpoint(input.workspaceId, input.name), status: "ready" })),
    deleteWorkspaceHistory: async () => unavailable("Deleting typed Rust recovery history is not available"),
    fenceUnfinishedOperations: async () => { const pending: WorkspaceCombinedRecoveryOperation[] = []; for (const workspace of await documents.listWorkspaceRegistrations()) for (const summary of await durable.listOperations(workspace.workspaceId, "combined")) { if (summary.state === "planned" || TERMINAL_STATES.has(String(summary.state))) continue; const full = await durable.getOperation(workspace.workspaceId, String(summary.operationId)); if (full) pending.push(publicOperation(parseCombined(full))); } return pending; },
    getCombinedOperation: (operationId) => safe(async () => ({ operation: publicOperation(await findCombined(operationId)), status: "ready" })),
    getStorageMove: async () => unavailable("Rust recovery storage does not create standalone move operations"),
    listCheckpoints: (input) => safe(async () => {
      const checkpoints = await durable.listCheckpoints(input.workspaceId);
      const found = input.cursor === undefined ? 0 : checkpoints.findIndex((value) => value.sequence < input.cursor!);
      const start = found < 0 ? checkpoints.length : found;
      const page = checkpoints.slice(start, input.limit === undefined ? undefined : start + input.limit);
      return {
        page: {
          checkpoints: page,
          nextCursor: input.limit !== undefined && start + page.length < checkpoints.length ? page.at(-1)?.sequence ?? null : null,
        },
        status: "ready",
      };
    }),
    listCombinedOperations: (workspaceId) => safe(async () => {
      const summaries = await durable.listOperations(workspaceId, "combined");
      const stored = await Promise.all(summaries.map((value) => durable.getOperation(workspaceId, requireString(value.operationId, "Recovery operation id"))));
      return {
        operations: stored.filter((value): value is Record<string, unknown> => Boolean(value)).map(parseCombined).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map(publicOperation),
        status: "ready",
      };
    }),
    listStorageWorkspaces: () => safe(async () => {
      const status = await storage();
      const workspaces = await Promise.all((await documents.listWorkspaceRegistrations()).map(async (registration) => {
        const [checkpoints, operations] = await Promise.all([
          durable.listCheckpoints(registration.workspaceId),
          durable.listOperations(registration.workspaceId),
        ]);
        if (checkpoints.length === 0 && operations.length === 0) return null;
        return {
          canonicalRoot: registration.canonicalPath,
          catalog: status.catalog,
          checkpointCount: checkpoints.length,
          lastActivityAt: [...checkpoints.map((checkpoint) => checkpoint.createdAt), ...operations.map((value) => value.updatedAt)]
            .filter((value): value is string => typeof value === "string").sort().at(-1) ?? null,
          location: status.location,
          locationSource: status.locationSource,
          migrationRequired: false,
          state: status.state,
          storageAvailable: true,
          workspaceAvailable: true,
          workspaceId: registration.workspaceId,
        };
      }));
      return { status: "ready", workspaces: workspaces.filter((workspace) => workspace !== null) };
    }),
    prepareCombinedRecovery: (input) => safe(async () => ({ plan: await track(() => prepareCombined(input)), status: "ready" })),
    prepareCombinedUndo: (operationId) => safe(async () => {
      return { plan: await runOperation(operationId, () => prepareUndo(operationId)), status: "ready" };
    }),
    recordMutationAfter: (input) => safe(async () => ({ recorded: await durable.recordMutationAfter(input), status: "ready" })),
    recordMutationBefore: (input) => safe(async () => ({ recorded: await durable.recordMutationBefore(input), status: "ready" })),
    recordTurnSettled: (input) => safe(async () => ({ binding: await durable.recordTurnSettled(input), status: "ready" })),
    recordTurnStart: (input) => safe(async () => ({ binding: await durable.recordTurnStart(input), status: "ready" })),
    retentionStatus: (workspaceId) => safe(async () => ({ retention: await retention(workspaceId), status: "ready" })),
    resolveEntry: (input) => durable.resolveEntry(input),
    resumeCombinedOperations: resume,
    resumeWorkspaceOperations: async () => [],
    setDefaultStorageLocation: async () => unavailable("Rust recovery storage is fixed to the Application Host kernel data directory"),
    setRetentionPolicy: async () => unavailable("Recovery retention policy is owned by the Rust kernel and is not configurable"),
    setStorageLocation: async () => unavailable("Rust recovery storage cannot be moved independently of kernel storage"),
    status: (workspaceId) => safe(async () => {
      const attention = (await durable.listOperations(workspaceId, "agent-mutation")).filter((value) => value.state === "needs-attention");
      return {
        capabilities: {
          bindings: true,
          catalogLifecycle: true,
          checkpoints: true,
          combined: true,
          conflictConfirmation: true,
          dirtyStateBarrier: true,
          journal: true,
          redo: true,
          retention: false,
          storageManagement: false,
          workspaceLease: false,
        },
        failures: [
          ...(startupFailures.get(workspaceId) ?? []),
          ...attention.map((value) => ({
            code: "needs-attention" as const,
            message: `Agent surface mutation ${String(value.operationId)} requires attention`,
            operationId: String(value.operationId),
            origin: "storage" as const,
            retryable: false,
          })),
        ],
        identity: await identityFor(workspaceId),
        retention: await retention(workspaceId),
        status: "ready",
        storage: await storage(workspaceId),
      };
    }),
    storageStatus: (workspaceId) => safe(async () => ({ status: "ready", storage: await storage(workspaceId) })),
    coordinateWorkspaceStorage,
    withWorkspaceStorage: (workspaceId, access, callback) => {
      const execute = async () => {
      const identity = await identityFor(workspaceId);
      return callback({
        durableRecoveryStore: durable,
        fileStore,
        identity,
        resourceOperationGate: gateFor(workspaceId),
        root: identity.canonicalRoot,
        ...(resolveDirectoryApplyContext ? { resolveDirectoryApplyContext } : {}),
        ...(durable.collectUnreachableObjects ? { collectUnreachableObjects: () => durable.collectUnreachableObjects!(workspaceId) } : {}),
      });
      };
      // Shared callers rely on their resource leases and Rust CAS. Only a
      // compound Host metadata read/modify/write occupies this serial section.
      return coordinateWorkspaceStorage(workspaceId, access, execute);
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await Promise.allSettled([...queues.values(), ...inFlight]);
    },
  } as WorkspaceRecoveryEngine;
};
