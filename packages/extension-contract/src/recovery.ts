import {
  VARIN_WORKSPACE_RECOVERY_SERVICE_ID,
  VARIN_WORKSPACE_RECOVERY_SERVICE_VERSION,
} from "./services.js";
import type { JsonObject, JsonValue, VarinExtensionServiceInvocationRequest } from "./types.js";

export const VARIN_WORKSPACE_RECOVERY_CONTRACT_VERSION = 5 as const;

export type WorkspaceRecoveryFailureCode =
  | "invalid-request" | "workspace-not-found" | "workspace-untrusted"
  | "checkpoint-unavailable" | "checkpoint-missing" | "checkpoint-incomplete" | "checkpoint-corrupt"
  | "object-missing" | "object-corrupt" | "storage-malformed" | "storage-move-failed"
  | "storage-schema-newer" | "storage-schema-retired" | "storage-overlap"
  | "operation-not-found" | "stale-plan" | "path-conflict" | "dirty-buffers"
  | "dirty-state-unavailable" | "lease-unavailable" | "locked-path" | "unsupported-metadata" | "navigation-conflict"
  | "recovery-in-progress" | "needs-attention" | "unavailable" | "internal";

export type WorkspaceRecoveryFailureOrigin =
  | "provider" | "coverage" | "storage" | "conflict" | "navigation" | "concurrency" | "internal";

export interface WorkspaceRecoveryFailure {
  code: WorkspaceRecoveryFailureCode;
  details?: JsonObject;
  message: string;
  operationId?: string;
  origin?: WorkspaceRecoveryFailureOrigin;
  retryable: boolean;
}

export interface WorkspaceRecoveryIdentity {
  authorityId: string;
  canonicalRoot: string;
  filesystemProfile: string;
  workspaceId: string;
}

export type WorkspaceRecoveryCheckpointSource = "turn" | "named" | "restore";
export type WorkspaceRecoveryCheckpointState = "pending" | "ready" | "incomplete";

export interface WorkspaceRecoveryCheckpointSummary {
  byteLength: number;
  changedPathCount: number;
  createdAt: string;
  entryId?: string;
  executionId?: string;
  id: string;
  label?: string;
  sequence: number;
  sessionId?: string;
  source: WorkspaceRecoveryCheckpointSource;
  state: WorkspaceRecoveryCheckpointState;
  workspaceId: string;
}

export interface WorkspaceRecoveryCheckpointInput { name: string; workspaceId: string }
export interface WorkspaceRecoveryCheckpointQuery { cursor?: number; limit?: number; workspaceId: string }
export interface WorkspaceRecoveryCheckpointPage {
  checkpoints: WorkspaceRecoveryCheckpointSummary[];
  nextCursor: number | null;
}

export type WorkspaceRecoveryTurnProvenance = "caused-by" | "observed-during" | "overlapped";

export interface WorkspaceRecoveryTurnStartInput {
  activeWriterScopes: string[];
  executionId: string;
  failure?: WorkspaceRecoveryFailure;
  provenance: WorkspaceRecoveryTurnProvenance;
  runtimeGeneration: number;
  sessionId: string;
  userEntryId: string;
  workerId: string;
  workspaceId: string;
}

export interface WorkspaceRecoveryMutationBeforeInput {
  executionId: string;
  mutationId: string;
  path: string;
  toolCallId: string;
  toolName: "write" | "edit";
  workspaceId: string;
}

export interface WorkspaceRecoveryMutationAfterInput extends WorkspaceRecoveryMutationBeforeInput {
  succeeded: boolean;
}

export interface WorkspaceRecoveryTurnSettledInput {
  activeWriterScopes: string[];
  assistantEntryId?: string;
  executionId: string;
  failure?: WorkspaceRecoveryFailure;
  mutationObserved: boolean;
  observationComplete: boolean;
  observedResourceIds: string[];
  provenance: WorkspaceRecoveryTurnProvenance;
  workspaceId: string;
}

export interface WorkspaceRecoveryTurnBinding {
  activeWriterScopes: string[];
  assistantEntryId?: string;
  checkpointId: string;
  executionId: string;
  failure?: WorkspaceRecoveryFailure;
  provenance: WorkspaceRecoveryTurnProvenance;
  runtimeGeneration: number;
  runtimeKey: string;
  sessionId: string;
  settledAt?: string;
  startedAt: string;
  status: WorkspaceRecoveryCheckpointState;
  unrecordedResourceIds: string[];
  userEntryId: string;
  workerId: string;
  workspaceId: string;
}

export interface WorkspaceRecoveryEntryTarget { entryId: string; sessionId: string; workspaceId: string }
export type WorkspaceRecoveryEntryBindingResult =
  | { binding: WorkspaceRecoveryTurnBinding; checkpoint: WorkspaceRecoveryCheckpointSummary; position: "before" | "after"; status: "ready" }
  | { binding?: WorkspaceRecoveryTurnBinding; reason: "entry-unbound" | "session-unbound" | "checkpoint-incomplete"; status: "unbound" | "incomplete" }
  | WorkspaceRecoveryFailedResult;

export type WorkspaceRecoveryConflictKind = "content-changed" | "dirty-buffer" | "unsupported";
export interface WorkspaceRecoveryConflict { fingerprint: string; kind: WorkspaceRecoveryConflictKind; message: string; path: string }
export interface WorkspaceRecoveryConfirmedConflict { fingerprint: string; path: string }
export interface WorkspaceCombinedRecoveryPrepareInput { entryId: string; sessionId: string; workspaceId: string }

export type WorkspaceRecoveryUncoveredSource = "shell" | "external" | "unknown";
export interface WorkspaceRecoveryUncoveredPath { path: string; source: WorkspaceRecoveryUncoveredSource }

export type WorkspaceCombinedRecoveryCoverage = "ready" | "partial" | "none";

export interface WorkspaceCombinedRecoveryPlan {
  affectedPaths: string[];
  changedBytes: number;
  conflicts: WorkspaceRecoveryConflict[];
  coverage: WorkspaceCombinedRecoveryCoverage;
  createdAt: string;
  entryId: string;
  expectedLeafId: string | null;
  id: string;
  removedEntryIds: string[];
  revision: string;
  sessionId: string;
  targetLeafId: string | null;
  uncoveredPaths: WorkspaceRecoveryUncoveredPath[];
  uncoveredReasons: string[];
  undoOf?: string;
  workspaceId: string;
}

export type WorkspaceRecoveryConflictPolicy = "abort" | "overwrite-confirmed";
export interface WorkspaceCombinedRecoveryApplyInput {
  confirmedConflicts: WorkspaceRecoveryConfirmedConflict[];
  conflictPolicy: WorkspaceRecoveryConflictPolicy;
  expectedRevision: string;
  operationId: string;
}

export type WorkspaceCombinedRecoveryOperationState =
  | "planned" | "applying-files" | "files-restored" | "navigating-conversation"
  | "compensating-files" | "compensated" | "complete" | "aborted" | "needs-attention";

export interface WorkspaceRecoveryEditorImage { data: string; mimeType: string }
export interface WorkspaceCombinedRecoveryOperation {
  affectedPathCount: number;
  appliedPathCount: number;
  conversationState: "unchanged" | "navigated" | "diverged";
  createdAt: string;
  editorImages?: WorkspaceRecoveryEditorImage[];
  editorText?: string;
  entryId: string;
  expectedLeafId: string | null;
  failure?: WorkspaceRecoveryFailure;
  fileState: "unchanged" | "restored" | "compensated" | "needs-attention";
  id: string;
  navigationMarkerId?: string;
  revision: string;
  sessionId: string;
  state: WorkspaceCombinedRecoveryOperationState;
  targetLeafId: string | null;
  undoOf?: string;
  updatedAt: string;
  workspaceId: string;
}

export type RecoveryStorageMode = "application-data" | "workspace-local" | "workspace-adjacent" | "custom";
export type RecoveryStorageLocation =
  | { mode: Exclude<RecoveryStorageMode, "custom"> }
  | { customRoot: string; mode: "custom" };

export type RecoveryCatalogState = "missing" | "ready" | "migrated" | "retired-history";
export interface RecoveryCatalogStatus {
  currentSchemaVersion: number;
  migratedFrom?: number;
  retiredCatalogCount: number;
  state: RecoveryCatalogState;
}

export interface RecoveryStorageStatus {
  authorityId: string;
  /** Host scope counts shared catalog storage, not this workspace's retained history. */
  scope?: "host" | "workspace";
  byteLength: number;
  catalog: RecoveryCatalogStatus;
  checkpointCount: number;
  encryption: { available: boolean; enabled: boolean };
  location: RecoveryStorageLocation;
  locationSource: "global" | "workspace";
  objectCount: number;
  readyCheckpointCount: number;
  registryRevision: number;
  state: "missing" | "ready" | "incomplete" | "malformed" | "corrupt";
  workspaceId?: string;
}

export interface SetRecoveryStorageLocationInput { location: RecoveryStorageLocation; workspaceId: string }
export interface RecoveryStorageWorkspaceSummary {
  /** Omitted when the provider cannot attribute shared physical storage to one workspace. */
  byteLength?: number;
  catalog: RecoveryCatalogStatus;
  canonicalRoot: string;
  checkpointCount: number;
  failure?: WorkspaceRecoveryFailure;
  lastActivityAt: string | null;
  location: RecoveryStorageLocation;
  locationSource: "global" | "workspace";
  migrationRequired: boolean;
  objectCount?: number;
  state: RecoveryStorageStatus["state"] | "unavailable";
  storageAvailable: boolean;
  workspaceAvailable: boolean;
  workspaceId: string;
}

export type RecoveryStorageMoveState = "copying" | "verifying" | "switching" | "complete" | "failed";
export interface RecoveryStorageMoveOperation {
  byteLength: number;
  failure?: WorkspaceRecoveryFailure;
  from: RecoveryStorageLocation;
  id: string;
  startedAt: string;
  state: RecoveryStorageMoveState;
  to: RecoveryStorageLocation;
  updatedAt: string;
  workspaceId: string;
}

export interface RecoveryStorageCleanupInput { workspaceId: string }
export interface RecoveryStorageCleanupResult {
  byteLengthReclaimed: number;
  failures: WorkspaceRecoveryFailure[];
  objectsDeleted: number;
  operationId: string;
  recordsDeleted: number;
  status: "complete" | "failed";
  workspaceId: string;
}

export interface RecoveryRetentionPolicy {
  maxAgeDays: number | null;
  maxByteLength: number | null;
  maxCheckpointCount: number | null;
  maxOperationCount: number | null;
}

export interface RecoveryRetentionPolicyInput {
  policy: RecoveryRetentionPolicy;
  workspaceId: string;
}

export interface RecoveryRetentionStatus {
  eligibleCheckpointCount: number;
  lastRunAt: string | null;
  oldestProtectedOperationAt: string | null;
  policy: RecoveryRetentionPolicy;
  protectedCheckpointCount: number;
  protectedOperationCount: number;
  retainedByteLength: number;
  terminalOperationCount: number;
  workspaceId: string;
}

export interface WorkspaceRecoveryStatus {
  capabilities: {
    bindings: boolean;
    catalogLifecycle: boolean;
    checkpoints: boolean;
    combined: boolean;
    conflictConfirmation: boolean;
    dirtyStateBarrier: boolean;
    journal: boolean;
    redo: boolean;
    retention: boolean;
    storageManagement: boolean;
    workspaceLease: boolean;
  };
  failures: WorkspaceRecoveryFailure[];
  identity: WorkspaceRecoveryIdentity;
  retention: RecoveryRetentionStatus;
  status: "ready";
  storage: RecoveryStorageStatus;
}

export interface WorkspaceRecoveryFailedResult { failure: WorkspaceRecoveryFailure; status: "failed" }
export type WorkspaceRecoveryCheckpointResult = { checkpoint: WorkspaceRecoveryCheckpointSummary; status: "ready" } | WorkspaceRecoveryFailedResult;
export type WorkspaceRecoveryCheckpointListResult = { page: WorkspaceRecoveryCheckpointPage; status: "ready" } | WorkspaceRecoveryFailedResult;
export type WorkspaceRecoveryTurnBindingResult = { binding: WorkspaceRecoveryTurnBinding; status: "ready" } | WorkspaceRecoveryFailedResult;
export type WorkspaceRecoveryMutationResult = { recorded: boolean; status: "ready" } | WorkspaceRecoveryFailedResult;
export type WorkspaceCombinedRecoveryPrepareResult = { plan: WorkspaceCombinedRecoveryPlan; status: "ready" } | WorkspaceRecoveryFailedResult;
export type WorkspaceCombinedRecoveryOperationResult = { operation: WorkspaceCombinedRecoveryOperation; status: "ready" } | WorkspaceRecoveryFailedResult;
export type WorkspaceCombinedRecoveryListResult = { operations: WorkspaceCombinedRecoveryOperation[]; status: "ready" } | WorkspaceRecoveryFailedResult;
export type WorkspaceRecoveryStatusResult = WorkspaceRecoveryStatus | WorkspaceRecoveryFailedResult;
export type RecoveryStorageStatusResult = { status: "ready"; storage: RecoveryStorageStatus } | WorkspaceRecoveryFailedResult;
export type RecoveryStorageMoveResult = { operation: RecoveryStorageMoveOperation; status: "ready" } | WorkspaceRecoveryFailedResult;
export type RecoveryStorageCleanupOperationResult = { result: RecoveryStorageCleanupResult; status: "ready" } | WorkspaceRecoveryFailedResult;
export type RecoveryStorageWorkspaceListResult = { status: "ready"; workspaces: RecoveryStorageWorkspaceSummary[] } | WorkspaceRecoveryFailedResult;
export type RecoveryRetentionStatusResult = { retention: RecoveryRetentionStatus; status: "ready" } | WorkspaceRecoveryFailedResult;

export class WorkspaceRecoveryContractError extends Error {
  constructor(message: string) { super(message); this.name = "WorkspaceRecoveryContractError" }
}

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceRecoveryContractError(`${label} must be an object`);
  return value as Record<string, unknown>;
};
const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new WorkspaceRecoveryContractError(`${label} must be a non-empty string`);
  return value;
};
const optionalText = (value: unknown, label: string): string | undefined => value === undefined ? undefined : text(value, label);
const count = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new WorkspaceRecoveryContractError(`${label} must be a non-negative safe integer`);
  return value as number;
};
const nullableCount = (value: unknown, label: string): number | null => (
  value === null ? null : count(value, label)
);
const positive = (value: unknown, label: string): number => {
  const parsed = count(value, label); if (parsed === 0) throw new WorkspaceRecoveryContractError(`${label} must be positive`); return parsed;
};
const isoTimestamp = (value: unknown, label: string): string => {
  const parsed = text(value, label); if (!Number.isFinite(Date.parse(parsed))) throw new WorkspaceRecoveryContractError(`${label} must be an ISO timestamp`); return parsed;
};
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], label: string): T => {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new WorkspaceRecoveryContractError(`${label} is unsupported`);
  return value as T;
};
const bool = (value: unknown, label: string): boolean => {
  if (typeof value !== "boolean") throw new WorkspaceRecoveryContractError(`${label} must be boolean`); return value;
};
const stringList = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value)) throw new WorkspaceRecoveryContractError(`${label} must be an array`);
  return value.map((item, index) => text(item, `${label}[${index}]`));
};

const FAILURE_CODES: readonly WorkspaceRecoveryFailureCode[] = [
  "invalid-request", "workspace-not-found", "workspace-untrusted", "checkpoint-unavailable", "checkpoint-missing",
  "checkpoint-incomplete", "checkpoint-corrupt", "object-missing", "object-corrupt", "storage-malformed",
  "storage-move-failed", "storage-schema-newer", "storage-schema-retired", "storage-overlap", "operation-not-found",
  "stale-plan", "path-conflict", "dirty-buffers", "dirty-state-unavailable", "lease-unavailable", "locked-path",
  "unsupported-metadata", "navigation-conflict", "recovery-in-progress", "needs-attention", "unavailable", "internal",
];
const FAILURE_ORIGINS: readonly WorkspaceRecoveryFailureOrigin[] = [
  "provider", "coverage", "storage", "conflict", "navigation", "concurrency", "internal",
];

export const parseWorkspaceRecoveryFailure = (value: unknown): WorkspaceRecoveryFailure => {
  const raw = record(value, "Workspace recovery failure");
  if (raw.details !== undefined && (!raw.details || typeof raw.details !== "object" || Array.isArray(raw.details))) {
    throw new WorkspaceRecoveryContractError("failure.details must be an object");
  }
  return {
    code: oneOf(raw.code, FAILURE_CODES, "failure.code"), message: text(raw.message, "failure.message"),
    retryable: bool(raw.retryable, "failure.retryable"),
    ...(raw.details === undefined ? {} : { details: raw.details as JsonObject }),
    ...(optionalText(raw.operationId, "failure.operationId") ? { operationId: raw.operationId as string } : {}),
    ...(raw.origin === undefined ? {} : { origin: oneOf(raw.origin, FAILURE_ORIGINS, "failure.origin") }),
  };
};

export const parseWorkspaceRecoveryIdentity = (value: unknown): WorkspaceRecoveryIdentity => {
  const raw = record(value, "Workspace recovery identity");
  return { authorityId: text(raw.authorityId, "identity.authorityId"), canonicalRoot: text(raw.canonicalRoot, "identity.canonicalRoot"), filesystemProfile: text(raw.filesystemProfile, "identity.filesystemProfile"), workspaceId: text(raw.workspaceId, "identity.workspaceId") };
};

export const parseWorkspaceRecoveryCheckpointSummary = (value: unknown): WorkspaceRecoveryCheckpointSummary => {
  const raw = record(value, "Workspace recovery checkpoint");
  return {
    byteLength: count(raw.byteLength, "checkpoint.byteLength"), changedPathCount: count(raw.changedPathCount, "checkpoint.changedPathCount"),
    createdAt: isoTimestamp(raw.createdAt, "checkpoint.createdAt"), id: text(raw.id, "checkpoint.id"),
    sequence: positive(raw.sequence, "checkpoint.sequence"), source: oneOf(raw.source, ["turn", "named", "restore"] as const, "checkpoint.source"),
    state: oneOf(raw.state, ["pending", "ready", "incomplete"] as const, "checkpoint.state"), workspaceId: text(raw.workspaceId, "checkpoint.workspaceId"),
    ...(optionalText(raw.entryId, "checkpoint.entryId") ? { entryId: raw.entryId as string } : {}),
    ...(optionalText(raw.executionId, "checkpoint.executionId") ? { executionId: raw.executionId as string } : {}),
    ...(optionalText(raw.label, "checkpoint.label") ? { label: raw.label as string } : {}),
    ...(optionalText(raw.sessionId, "checkpoint.sessionId") ? { sessionId: raw.sessionId as string } : {}),
  };
};

export const parseWorkspaceRecoveryCheckpointInput = (value: unknown): WorkspaceRecoveryCheckpointInput => {
  const raw = record(value, "Workspace checkpoint input"); return { name: text(raw.name, "checkpoint.name"), workspaceId: text(raw.workspaceId, "checkpoint.workspaceId") };
};
export const parseWorkspaceRecoveryCheckpointQuery = (value: unknown): WorkspaceRecoveryCheckpointQuery => {
  const raw = record(value, "Workspace checkpoint query");
  return { workspaceId: text(raw.workspaceId, "query.workspaceId"), ...(raw.cursor === undefined ? {} : { cursor: positive(raw.cursor, "query.cursor") }), ...(raw.limit === undefined ? {} : { limit: positive(raw.limit, "query.limit") }) };
};

const TURN_PROVENANCE = ["caused-by", "observed-during", "overlapped"] as const;
export const parseWorkspaceRecoveryTurnStartInput = (value: unknown): WorkspaceRecoveryTurnStartInput => {
  const raw = record(value, "Workspace recovery turn start");
  return {
    activeWriterScopes: stringList(raw.activeWriterScopes, "turn.activeWriterScopes"), executionId: text(raw.executionId, "turn.executionId"),
    provenance: oneOf(raw.provenance, TURN_PROVENANCE, "turn.provenance"), runtimeGeneration: positive(raw.runtimeGeneration, "turn.runtimeGeneration"),
    sessionId: text(raw.sessionId, "turn.sessionId"), userEntryId: text(raw.userEntryId, "turn.userEntryId"), workerId: text(raw.workerId, "turn.workerId"), workspaceId: text(raw.workspaceId, "turn.workspaceId"),
    ...(raw.failure === undefined ? {} : { failure: parseWorkspaceRecoveryFailure(raw.failure) }),
  };
};

const parseMutationBase = (raw: Record<string, unknown>) => ({
  executionId: text(raw.executionId, "mutation.executionId"), mutationId: text(raw.mutationId, "mutation.mutationId"), path: text(raw.path, "mutation.path"),
  toolCallId: text(raw.toolCallId, "mutation.toolCallId"), toolName: oneOf(raw.toolName, ["write", "edit"] as const, "mutation.toolName"), workspaceId: text(raw.workspaceId, "mutation.workspaceId"),
});
export const parseWorkspaceRecoveryMutationBeforeInput = (value: unknown): WorkspaceRecoveryMutationBeforeInput => parseMutationBase(record(value, "Workspace mutation before"));
export const parseWorkspaceRecoveryMutationAfterInput = (value: unknown): WorkspaceRecoveryMutationAfterInput => {
  const raw = record(value, "Workspace mutation after"); return { ...parseMutationBase(raw), succeeded: bool(raw.succeeded, "mutation.succeeded") };
};
export const parseWorkspaceRecoveryTurnSettledInput = (value: unknown): WorkspaceRecoveryTurnSettledInput => {
  const raw = record(value, "Workspace recovery turn settlement");
  return {
    activeWriterScopes: stringList(raw.activeWriterScopes, "turn.activeWriterScopes"), executionId: text(raw.executionId, "turn.executionId"),
    mutationObserved: bool(raw.mutationObserved, "turn.mutationObserved"), observationComplete: bool(raw.observationComplete, "turn.observationComplete"),
    observedResourceIds: stringList(raw.observedResourceIds, "turn.observedResourceIds"), provenance: oneOf(raw.provenance, TURN_PROVENANCE, "turn.provenance"), workspaceId: text(raw.workspaceId, "turn.workspaceId"),
    ...(optionalText(raw.assistantEntryId, "turn.assistantEntryId") ? { assistantEntryId: raw.assistantEntryId as string } : {}),
    ...(raw.failure === undefined ? {} : { failure: parseWorkspaceRecoveryFailure(raw.failure) }),
  };
};

export const parseWorkspaceRecoveryTurnBinding = (value: unknown): WorkspaceRecoveryTurnBinding => {
  const raw = record(value, "Workspace recovery turn binding");
  return {
    activeWriterScopes: stringList(raw.activeWriterScopes, "binding.activeWriterScopes"), checkpointId: text(raw.checkpointId, "binding.checkpointId"),
    executionId: text(raw.executionId, "binding.executionId"), provenance: oneOf(raw.provenance, TURN_PROVENANCE, "binding.provenance"),
    runtimeGeneration: positive(raw.runtimeGeneration, "binding.runtimeGeneration"), runtimeKey: text(raw.runtimeKey, "binding.runtimeKey"),
    sessionId: text(raw.sessionId, "binding.sessionId"), startedAt: isoTimestamp(raw.startedAt, "binding.startedAt"),
    status: oneOf(raw.status, ["pending", "ready", "incomplete"] as const, "binding.status"), unrecordedResourceIds: stringList(raw.unrecordedResourceIds, "binding.unrecordedResourceIds"),
    userEntryId: text(raw.userEntryId, "binding.userEntryId"), workerId: text(raw.workerId, "binding.workerId"), workspaceId: text(raw.workspaceId, "binding.workspaceId"),
    ...(optionalText(raw.assistantEntryId, "binding.assistantEntryId") ? { assistantEntryId: raw.assistantEntryId as string } : {}),
    ...(raw.failure === undefined ? {} : { failure: parseWorkspaceRecoveryFailure(raw.failure) }),
    ...(optionalText(raw.settledAt, "binding.settledAt") ? { settledAt: raw.settledAt as string } : {}),
  };
};

export const parseWorkspaceRecoveryEntryTarget = (value: unknown): WorkspaceRecoveryEntryTarget => {
  const raw = record(value, "Workspace recovery entry target"); return { entryId: text(raw.entryId, "target.entryId"), sessionId: text(raw.sessionId, "target.sessionId"), workspaceId: text(raw.workspaceId, "target.workspaceId") };
};
export const parseWorkspaceCombinedRecoveryPrepareInput = (value: unknown): WorkspaceCombinedRecoveryPrepareInput => parseWorkspaceRecoveryEntryTarget(value);
export const parseWorkspaceRecoveryConflict = (value: unknown): WorkspaceRecoveryConflict => {
  const raw = record(value, "Workspace recovery conflict"); return { fingerprint: text(raw.fingerprint, "conflict.fingerprint"), kind: oneOf(raw.kind, ["content-changed", "dirty-buffer", "unsupported"] as const, "conflict.kind"), message: text(raw.message, "conflict.message"), path: text(raw.path, "conflict.path") };
};
export const parseWorkspaceRecoveryConfirmedConflict = (value: unknown): WorkspaceRecoveryConfirmedConflict => {
  const raw = record(value, "Confirmed workspace recovery conflict"); return { fingerprint: text(raw.fingerprint, "confirmedConflict.fingerprint"), path: text(raw.path, "confirmedConflict.path") };
};
const parseWorkspaceRecoveryUncoveredPath = (value: unknown): WorkspaceRecoveryUncoveredPath => {
  const raw = record(value, "Uncovered recovery path");
  return {
    path: text(raw.path, "uncoveredPath.path"),
    source: oneOf(raw.source, ["shell", "external", "unknown"] as const, "uncoveredPath.source"),
  };
};
export const parseWorkspaceCombinedRecoveryPlan = (value: unknown): WorkspaceCombinedRecoveryPlan => {
  const raw = record(value, "Combined recovery plan");
  if (!Array.isArray(raw.conflicts)) throw new WorkspaceRecoveryContractError("plan.conflicts must be an array");
  if (!Array.isArray(raw.uncoveredPaths)) throw new WorkspaceRecoveryContractError("plan.uncoveredPaths must be an array");
  if (!Array.isArray(raw.uncoveredReasons)) throw new WorkspaceRecoveryContractError("plan.uncoveredReasons must be an array");
  return {
    affectedPaths: stringList(raw.affectedPaths, "plan.affectedPaths"), changedBytes: count(raw.changedBytes, "plan.changedBytes"), conflicts: raw.conflicts.map(parseWorkspaceRecoveryConflict),
    coverage: oneOf(raw.coverage, ["ready", "partial", "none"] as const, "plan.coverage"), createdAt: isoTimestamp(raw.createdAt, "plan.createdAt"), entryId: text(raw.entryId, "plan.entryId"),
    expectedLeafId: raw.expectedLeafId === null ? null : text(raw.expectedLeafId, "plan.expectedLeafId"), id: text(raw.id, "plan.id"), removedEntryIds: stringList(raw.removedEntryIds, "plan.removedEntryIds"),
    revision: text(raw.revision, "plan.revision"), sessionId: text(raw.sessionId, "plan.sessionId"), targetLeafId: raw.targetLeafId === null ? null : text(raw.targetLeafId, "plan.targetLeafId"),
    uncoveredPaths: raw.uncoveredPaths.map(parseWorkspaceRecoveryUncoveredPath),
    uncoveredReasons: stringList(raw.uncoveredReasons, "plan.uncoveredReasons"),
    workspaceId: text(raw.workspaceId, "plan.workspaceId"), ...(optionalText(raw.undoOf, "plan.undoOf") ? { undoOf: raw.undoOf as string } : {}),
  };
};
export const parseWorkspaceCombinedRecoveryApplyInput = (value: unknown): WorkspaceCombinedRecoveryApplyInput => {
  const raw = record(value, "Combined recovery apply input"); if (!Array.isArray(raw.confirmedConflicts)) throw new WorkspaceRecoveryContractError("apply.confirmedConflicts must be an array");
  const conflictPolicy = oneOf(raw.conflictPolicy, ["abort", "overwrite-confirmed"] as const, "apply.conflictPolicy");
  const confirmedConflicts = raw.confirmedConflicts.map(parseWorkspaceRecoveryConfirmedConflict);
  if (conflictPolicy === "abort" && confirmedConflicts.length > 0) throw new WorkspaceRecoveryContractError("abort cannot confirm conflicts");
  if (conflictPolicy === "overwrite-confirmed" && confirmedConflicts.length === 0) throw new WorkspaceRecoveryContractError("overwrite-confirmed requires at least one confirmed conflict");
  return { confirmedConflicts, conflictPolicy, expectedRevision: text(raw.expectedRevision, "apply.expectedRevision"), operationId: text(raw.operationId, "apply.operationId") };
};

const parseEditorImages = (value: unknown): WorkspaceRecoveryEditorImage[] => {
  if (!Array.isArray(value)) throw new WorkspaceRecoveryContractError("operation.editorImages must be an array");
  return value.map((item, index) => { const raw = record(item, `operation.editorImages[${index}]`); return { data: text(raw.data, `operation.editorImages[${index}].data`), mimeType: text(raw.mimeType, `operation.editorImages[${index}].mimeType`) }; });
};
export const parseWorkspaceCombinedRecoveryOperation = (value: unknown): WorkspaceCombinedRecoveryOperation => {
  const raw = record(value, "Combined recovery operation");
  return {
    affectedPathCount: count(raw.affectedPathCount, "operation.affectedPathCount"), appliedPathCount: count(raw.appliedPathCount, "operation.appliedPathCount"),
    conversationState: oneOf(raw.conversationState, ["unchanged", "navigated", "diverged"] as const, "operation.conversationState"), createdAt: isoTimestamp(raw.createdAt, "operation.createdAt"),
    entryId: text(raw.entryId, "operation.entryId"), expectedLeafId: raw.expectedLeafId === null ? null : text(raw.expectedLeafId, "operation.expectedLeafId"),
    fileState: oneOf(raw.fileState, ["unchanged", "restored", "compensated", "needs-attention"] as const, "operation.fileState"), id: text(raw.id, "operation.id"),
    revision: text(raw.revision, "operation.revision"), sessionId: text(raw.sessionId, "operation.sessionId"),
    state: oneOf(raw.state, ["planned", "applying-files", "files-restored", "navigating-conversation", "compensating-files", "compensated", "complete", "aborted", "needs-attention"] as const, "operation.state"),
    targetLeafId: raw.targetLeafId === null ? null : text(raw.targetLeafId, "operation.targetLeafId"), updatedAt: isoTimestamp(raw.updatedAt, "operation.updatedAt"), workspaceId: text(raw.workspaceId, "operation.workspaceId"),
    ...(raw.editorImages === undefined ? {} : { editorImages: parseEditorImages(raw.editorImages) }),
    ...(raw.editorText === undefined ? {} : { editorText: text(raw.editorText, "operation.editorText") }),
    ...(raw.failure === undefined ? {} : { failure: parseWorkspaceRecoveryFailure(raw.failure) }),
    ...(optionalText(raw.navigationMarkerId, "operation.navigationMarkerId") ? { navigationMarkerId: raw.navigationMarkerId as string } : {}),
    ...(optionalText(raw.undoOf, "operation.undoOf") ? { undoOf: raw.undoOf as string } : {}),
  };
};

export const parseRecoveryStorageLocation = (value: unknown): RecoveryStorageLocation => {
  const raw = record(value, "Recovery storage location"); const mode = oneOf(raw.mode, ["application-data", "workspace-local", "workspace-adjacent", "custom"] as const, "location.mode");
  if (mode === "custom") return { customRoot: text(raw.customRoot, "location.customRoot"), mode };
  if (raw.customRoot !== undefined) throw new WorkspaceRecoveryContractError("location.customRoot is only valid for custom mode"); return { mode };
};
export const parseRecoveryCatalogStatus = (value: unknown): RecoveryCatalogStatus => {
  const raw = record(value, "Recovery catalog status");
  return {
    currentSchemaVersion: count(raw.currentSchemaVersion, "catalog.currentSchemaVersion"),
    retiredCatalogCount: count(raw.retiredCatalogCount, "catalog.retiredCatalogCount"),
    state: oneOf(raw.state, ["missing", "ready", "migrated", "retired-history"] as const, "catalog.state"),
    ...(raw.migratedFrom === undefined ? {} : { migratedFrom: positive(raw.migratedFrom, "catalog.migratedFrom") }),
  };
};
export const parseSetRecoveryStorageLocationInput = (value: unknown): SetRecoveryStorageLocationInput => {
  const raw = record(value, "Set recovery storage location input"); return { location: parseRecoveryStorageLocation(raw.location), workspaceId: text(raw.workspaceId, "storage.workspaceId") };
};
export const parseRecoveryStorageCleanupInput = (value: unknown): RecoveryStorageCleanupInput => {
  const raw = record(value, "Recovery storage cleanup input"); return { workspaceId: text(raw.workspaceId, "cleanup.workspaceId") };
};
export const parseRecoveryRetentionPolicy = (value: unknown): RecoveryRetentionPolicy => {
  const raw = record(value, "Recovery retention policy");
  const policy = {
    maxAgeDays: nullableCount(raw.maxAgeDays, "retention.maxAgeDays"),
    maxByteLength: nullableCount(raw.maxByteLength, "retention.maxByteLength"),
    maxCheckpointCount: nullableCount(raw.maxCheckpointCount, "retention.maxCheckpointCount"),
    maxOperationCount: nullableCount(raw.maxOperationCount, "retention.maxOperationCount"),
  };
  if (policy.maxAgeDays !== null && !Number.isSafeInteger(policy.maxAgeDays * 86_400_000)) {
    throw new WorkspaceRecoveryContractError("retention.maxAgeDays exceeds the supported timestamp range");
  }
  return policy;
};
export const parseRecoveryRetentionPolicyInput = (value: unknown): RecoveryRetentionPolicyInput => {
  const raw = record(value, "Recovery retention policy input");
  return {
    policy: parseRecoveryRetentionPolicy(raw.policy),
    workspaceId: text(raw.workspaceId, "retention.workspaceId"),
  };
};
export const parseRecoveryRetentionStatus = (value: unknown): RecoveryRetentionStatus => {
  const raw = record(value, "Recovery retention status");
  return {
    eligibleCheckpointCount: count(raw.eligibleCheckpointCount, "retention.eligibleCheckpointCount"),
    lastRunAt: raw.lastRunAt === null ? null : isoTimestamp(raw.lastRunAt, "retention.lastRunAt"),
    oldestProtectedOperationAt: raw.oldestProtectedOperationAt === null
      ? null
      : isoTimestamp(raw.oldestProtectedOperationAt, "retention.oldestProtectedOperationAt"),
    policy: parseRecoveryRetentionPolicy(raw.policy),
    protectedCheckpointCount: count(raw.protectedCheckpointCount, "retention.protectedCheckpointCount"),
    protectedOperationCount: count(raw.protectedOperationCount, "retention.protectedOperationCount"),
    retainedByteLength: count(raw.retainedByteLength, "retention.retainedByteLength"),
    terminalOperationCount: count(raw.terminalOperationCount, "retention.terminalOperationCount"),
    workspaceId: text(raw.workspaceId, "retention.workspaceId"),
  };
};
export const parseRecoveryStorageStatus = (value: unknown): RecoveryStorageStatus => {
  const raw = record(value, "Recovery storage status"); const encryption = record(raw.encryption, "storage.encryption");
  return {
    ...(raw.scope === undefined ? {} : { scope: oneOf(raw.scope, ["host", "workspace"] as const, "storage.scope") }),
    authorityId: text(raw.authorityId, "storage.authorityId"), byteLength: count(raw.byteLength, "storage.byteLength"), catalog: parseRecoveryCatalogStatus(raw.catalog), checkpointCount: count(raw.checkpointCount, "storage.checkpointCount"),
    encryption: { available: bool(encryption.available, "storage.encryption.available"), enabled: bool(encryption.enabled, "storage.encryption.enabled") },
    location: parseRecoveryStorageLocation(raw.location), locationSource: oneOf(raw.locationSource, ["global", "workspace"] as const, "storage.locationSource"),
    objectCount: count(raw.objectCount, "storage.objectCount"), readyCheckpointCount: count(raw.readyCheckpointCount, "storage.readyCheckpointCount"), registryRevision: count(raw.registryRevision, "storage.registryRevision"),
    state: oneOf(raw.state, ["missing", "ready", "incomplete", "malformed", "corrupt"] as const, "storage.state"), ...(optionalText(raw.workspaceId, "storage.workspaceId") ? { workspaceId: raw.workspaceId as string } : {}),
  };
};
export const parseRecoveryStorageWorkspaceSummary = (value: unknown): RecoveryStorageWorkspaceSummary => {
  const raw = record(value, "Recovery storage workspace summary");
  return {
    ...(raw.byteLength === undefined ? {} : { byteLength: count(raw.byteLength, "workspace.byteLength") }), canonicalRoot: text(raw.canonicalRoot, "workspace.canonicalRoot"), catalog: parseRecoveryCatalogStatus(raw.catalog), checkpointCount: count(raw.checkpointCount, "workspace.checkpointCount"),
    lastActivityAt: raw.lastActivityAt === null ? null : isoTimestamp(raw.lastActivityAt, "workspace.lastActivityAt"), location: parseRecoveryStorageLocation(raw.location),
    locationSource: oneOf(raw.locationSource, ["global", "workspace"] as const, "workspace.locationSource"), migrationRequired: bool(raw.migrationRequired, "workspace.migrationRequired"),
    ...(raw.objectCount === undefined ? {} : { objectCount: count(raw.objectCount, "workspace.objectCount") }), state: oneOf(raw.state, ["missing", "ready", "incomplete", "malformed", "corrupt", "unavailable"] as const, "workspace.state"),
    storageAvailable: bool(raw.storageAvailable, "workspace.storageAvailable"), workspaceAvailable: bool(raw.workspaceAvailable, "workspace.workspaceAvailable"), workspaceId: text(raw.workspaceId, "workspace.workspaceId"),
    ...(raw.failure === undefined ? {} : { failure: parseWorkspaceRecoveryFailure(raw.failure) }),
  };
};
export const parseRecoveryStorageMoveOperation = (value: unknown): RecoveryStorageMoveOperation => {
  const raw = record(value, "Recovery storage move operation");
  return { byteLength: count(raw.byteLength, "move.byteLength"), from: parseRecoveryStorageLocation(raw.from), id: text(raw.id, "move.id"), startedAt: isoTimestamp(raw.startedAt, "move.startedAt"), state: oneOf(raw.state, ["copying", "verifying", "switching", "complete", "failed"] as const, "move.state"), to: parseRecoveryStorageLocation(raw.to), updatedAt: isoTimestamp(raw.updatedAt, "move.updatedAt"), workspaceId: text(raw.workspaceId, "move.workspaceId"), ...(raw.failure === undefined ? {} : { failure: parseWorkspaceRecoveryFailure(raw.failure) }) };
};
export const parseRecoveryStorageCleanupResult = (value: unknown): RecoveryStorageCleanupResult => {
  const raw = record(value, "Recovery storage cleanup result"); if (!Array.isArray(raw.failures)) throw new WorkspaceRecoveryContractError("cleanup.failures must be an array");
  return { byteLengthReclaimed: count(raw.byteLengthReclaimed, "cleanup.byteLengthReclaimed"), failures: raw.failures.map(parseWorkspaceRecoveryFailure), objectsDeleted: count(raw.objectsDeleted, "cleanup.objectsDeleted"), operationId: text(raw.operationId, "cleanup.operationId"), recordsDeleted: count(raw.recordsDeleted, "cleanup.recordsDeleted"), status: oneOf(raw.status, ["complete", "failed"] as const, "cleanup.status"), workspaceId: text(raw.workspaceId, "cleanup.workspaceId") };
};

const failed = (value: unknown): WorkspaceRecoveryFailedResult => {
  const raw = record(value, "Workspace recovery result"); if (raw.status !== "failed") throw new WorkspaceRecoveryContractError("result.status must be failed"); return { failure: parseWorkspaceRecoveryFailure(raw.failure), status: "failed" };
};
export const parseWorkspaceRecoveryCheckpointResult = (value: unknown): WorkspaceRecoveryCheckpointResult => {
  const raw = record(value, "Workspace checkpoint result"); return raw.status === "failed" ? failed(raw) : { checkpoint: parseWorkspaceRecoveryCheckpointSummary(raw.checkpoint), status: oneOf(raw.status, ["ready"] as const, "checkpoint result.status") };
};
export const parseWorkspaceRecoveryCheckpointListResult = (value: unknown): WorkspaceRecoveryCheckpointListResult => {
  const raw = record(value, "Workspace checkpoint list result"); if (raw.status === "failed") return failed(raw); const page = record(raw.page, "checkpoint list.page");
  if (!Array.isArray(page.checkpoints)) throw new WorkspaceRecoveryContractError("checkpoint list must be an array");
  return { page: { checkpoints: page.checkpoints.map(parseWorkspaceRecoveryCheckpointSummary), nextCursor: page.nextCursor === null ? null : positive(page.nextCursor, "checkpoint list.nextCursor") }, status: oneOf(raw.status, ["ready"] as const, "checkpoint list.status") };
};
export const parseWorkspaceRecoveryTurnBindingResult = (value: unknown): WorkspaceRecoveryTurnBindingResult => {
  const raw = record(value, "Workspace turn binding result"); return raw.status === "failed" ? failed(raw) : { binding: parseWorkspaceRecoveryTurnBinding(raw.binding), status: oneOf(raw.status, ["ready"] as const, "turn binding result.status") };
};
export const parseWorkspaceRecoveryMutationResult = (value: unknown): WorkspaceRecoveryMutationResult => {
  const raw = record(value, "Workspace mutation result"); return raw.status === "failed" ? failed(raw) : { recorded: bool(raw.recorded, "mutation result.recorded"), status: oneOf(raw.status, ["ready"] as const, "mutation result.status") };
};
export const parseWorkspaceRecoveryEntryBindingResult = (value: unknown): WorkspaceRecoveryEntryBindingResult => {
  const raw = record(value, "Workspace entry binding result"); if (raw.status === "failed") return failed(raw);
  const status = oneOf(raw.status, ["ready", "unbound", "incomplete"] as const, "entry binding.status");
  if (status === "ready") return { binding: parseWorkspaceRecoveryTurnBinding(raw.binding), checkpoint: parseWorkspaceRecoveryCheckpointSummary(raw.checkpoint), position: oneOf(raw.position, ["before", "after"] as const, "entry binding.position"), status };
  return { reason: oneOf(raw.reason, ["entry-unbound", "session-unbound", "checkpoint-incomplete"] as const, "entry binding.reason"), status, ...(raw.binding === undefined ? {} : { binding: parseWorkspaceRecoveryTurnBinding(raw.binding) }) };
};
export const parseWorkspaceCombinedRecoveryPrepareResult = (value: unknown): WorkspaceCombinedRecoveryPrepareResult => {
  const raw = record(value, "Combined recovery prepare result"); return raw.status === "failed" ? failed(raw) : { plan: parseWorkspaceCombinedRecoveryPlan(raw.plan), status: oneOf(raw.status, ["ready"] as const, "combined prepare.status") };
};
export const parseWorkspaceCombinedRecoveryOperationResult = (value: unknown): WorkspaceCombinedRecoveryOperationResult => {
  const raw = record(value, "Combined recovery operation result"); return raw.status === "failed" ? failed(raw) : { operation: parseWorkspaceCombinedRecoveryOperation(raw.operation), status: oneOf(raw.status, ["ready"] as const, "combined operation.status") };
};
export const parseWorkspaceCombinedRecoveryListResult = (value: unknown): WorkspaceCombinedRecoveryListResult => {
  const raw = record(value, "Combined recovery operation list"); if (raw.status === "failed") return failed(raw); if (!Array.isArray(raw.operations)) throw new WorkspaceRecoveryContractError("combined operations must be an array");
  return { operations: raw.operations.map(parseWorkspaceCombinedRecoveryOperation), status: oneOf(raw.status, ["ready"] as const, "combined operations.status") };
};
export const parseWorkspaceRecoveryStatusResult = (value: unknown): WorkspaceRecoveryStatusResult => {
  const raw = record(value, "Workspace recovery status result"); if (raw.status === "failed") return failed(raw); const capabilities = record(raw.capabilities, "status.capabilities"); if (!Array.isArray(raw.failures)) throw new WorkspaceRecoveryContractError("status.failures must be an array");
  return {
    capabilities: { bindings: bool(capabilities.bindings, "status.capabilities.bindings"), catalogLifecycle: bool(capabilities.catalogLifecycle, "status.capabilities.catalogLifecycle"), checkpoints: bool(capabilities.checkpoints, "status.capabilities.checkpoints"), combined: bool(capabilities.combined, "status.capabilities.combined"), conflictConfirmation: bool(capabilities.conflictConfirmation, "status.capabilities.conflictConfirmation"), dirtyStateBarrier: bool(capabilities.dirtyStateBarrier, "status.capabilities.dirtyStateBarrier"), journal: bool(capabilities.journal, "status.capabilities.journal"), redo: bool(capabilities.redo, "status.capabilities.redo"), retention: bool(capabilities.retention, "status.capabilities.retention"), storageManagement: bool(capabilities.storageManagement, "status.capabilities.storageManagement"), workspaceLease: bool(capabilities.workspaceLease, "status.capabilities.workspaceLease") },
    failures: raw.failures.map(parseWorkspaceRecoveryFailure),
    identity: parseWorkspaceRecoveryIdentity(raw.identity),
    retention: parseRecoveryRetentionStatus(raw.retention),
    status: oneOf(raw.status, ["ready"] as const, "status.status"),
    storage: parseRecoveryStorageStatus(raw.storage),
  };
};
export const parseRecoveryStorageStatusResult = (value: unknown): RecoveryStorageStatusResult => {
  const raw = record(value, "Recovery storage result"); return raw.status === "failed" ? failed(raw) : { status: oneOf(raw.status, ["ready"] as const, "storage result.status"), storage: parseRecoveryStorageStatus(raw.storage) };
};
export const parseRecoveryStorageMoveResult = (value: unknown): RecoveryStorageMoveResult => {
  const raw = record(value, "Recovery storage move result"); return raw.status === "failed" ? failed(raw) : { operation: parseRecoveryStorageMoveOperation(raw.operation), status: oneOf(raw.status, ["ready"] as const, "move result.status") };
};
export const parseRecoveryStorageCleanupOperationResult = (value: unknown): RecoveryStorageCleanupOperationResult => {
  const raw = record(value, "Recovery cleanup result"); return raw.status === "failed" ? failed(raw) : { result: parseRecoveryStorageCleanupResult(raw.result), status: oneOf(raw.status, ["ready"] as const, "cleanup result.status") };
};
export const parseRecoveryStorageWorkspaceListResult = (value: unknown): RecoveryStorageWorkspaceListResult => {
  const raw = record(value, "Recovery storage workspace list"); if (raw.status === "failed") return failed(raw); if (!Array.isArray(raw.workspaces)) throw new WorkspaceRecoveryContractError("Recovery storage workspaces must be an array");
  return { status: oneOf(raw.status, ["ready"] as const, "workspace list.status"), workspaces: raw.workspaces.map(parseRecoveryStorageWorkspaceSummary) };
};
export const parseRecoveryRetentionStatusResult = (value: unknown): RecoveryRetentionStatusResult => {
  const raw = record(value, "Recovery retention result");
  return raw.status === "failed"
    ? failed(raw)
    : {
        retention: parseRecoveryRetentionStatus(raw.retention),
        status: oneOf(raw.status, ["ready"] as const, "retention result.status"),
      };
};

export interface WorkspaceRecoveryAPI {
  applyCombinedRecovery(input: WorkspaceCombinedRecoveryApplyInput): Promise<WorkspaceCombinedRecoveryOperationResult>;
  cancelCombinedOperation(operationId: string): Promise<WorkspaceCombinedRecoveryOperationResult>;
  clearStorageLocationOverride(workspaceId: string): Promise<RecoveryStorageMoveResult>;
  cleanupStorage(input: RecoveryStorageCleanupInput): Promise<RecoveryStorageCleanupOperationResult>;
  createCheckpoint(input: WorkspaceRecoveryCheckpointInput): Promise<WorkspaceRecoveryCheckpointResult>;
  deleteWorkspaceHistory(workspaceId: string): Promise<RecoveryStorageCleanupOperationResult>;
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
  setDefaultStorageLocation(location: RecoveryStorageLocation): Promise<RecoveryStorageStatusResult>;
  setRetentionPolicy(input: RecoveryRetentionPolicyInput): Promise<RecoveryRetentionStatusResult>;
  setStorageLocation(input: SetRecoveryStorageLocationInput): Promise<RecoveryStorageMoveResult>;
  status(workspaceId: string): Promise<WorkspaceRecoveryStatusResult>;
  storageStatus(workspaceId?: string): Promise<RecoveryStorageStatusResult>;
}

export type WorkspaceRecoveryServiceInvoker = (request: VarinExtensionServiceInvocationRequest) => Promise<JsonValue>;
export const createWorkspaceRecoveryAPI = (invokeService: WorkspaceRecoveryServiceInvoker): WorkspaceRecoveryAPI => {
  const call = (method: string, args: JsonValue[]) => invokeService({ args, method, serviceId: VARIN_WORKSPACE_RECOVERY_SERVICE_ID, version: VARIN_WORKSPACE_RECOVERY_SERVICE_VERSION });
  return {
    applyCombinedRecovery: async (input) => parseWorkspaceCombinedRecoveryOperationResult(await call("applyCombinedRecovery", [parseWorkspaceCombinedRecoveryApplyInput(input) as unknown as JsonValue])),
    cancelCombinedOperation: async (id) => parseWorkspaceCombinedRecoveryOperationResult(await call("cancelCombinedOperation", [text(id, "operationId")])),
    clearStorageLocationOverride: async (id) => parseRecoveryStorageMoveResult(await call("clearStorageLocationOverride", [text(id, "workspaceId")])),
    cleanupStorage: async (input) => parseRecoveryStorageCleanupOperationResult(await call("cleanupStorage", [parseRecoveryStorageCleanupInput(input) as unknown as JsonValue])),
    createCheckpoint: async (input) => parseWorkspaceRecoveryCheckpointResult(await call("createCheckpoint", [parseWorkspaceRecoveryCheckpointInput(input) as unknown as JsonValue])),
    deleteWorkspaceHistory: async (id) => parseRecoveryStorageCleanupOperationResult(await call("deleteWorkspaceHistory", [text(id, "workspaceId")])),
    getCombinedOperation: async (id) => parseWorkspaceCombinedRecoveryOperationResult(await call("getCombinedOperation", [text(id, "operationId")])),
    getStorageMove: async (id) => parseRecoveryStorageMoveResult(await call("getStorageMove", [text(id, "operationId")])),
    listCheckpoints: async (input) => parseWorkspaceRecoveryCheckpointListResult(await call("listCheckpoints", [parseWorkspaceRecoveryCheckpointQuery(input) as unknown as JsonValue])),
    listCombinedOperations: async (id) => parseWorkspaceCombinedRecoveryListResult(await call("listCombinedOperations", [text(id, "workspaceId")])),
    listStorageWorkspaces: async () => parseRecoveryStorageWorkspaceListResult(await call("listStorageWorkspaces", [])),
    prepareCombinedRecovery: async (input) => parseWorkspaceCombinedRecoveryPrepareResult(await call("prepareCombinedRecovery", [parseWorkspaceCombinedRecoveryPrepareInput(input) as unknown as JsonValue])),
    prepareCombinedUndo: async (id) => parseWorkspaceCombinedRecoveryPrepareResult(await call("prepareCombinedUndo", [text(id, "operationId")])),
    recordMutationAfter: async (input) => parseWorkspaceRecoveryMutationResult(await call("recordMutationAfter", [parseWorkspaceRecoveryMutationAfterInput(input) as unknown as JsonValue])),
    recordMutationBefore: async (input) => parseWorkspaceRecoveryMutationResult(await call("recordMutationBefore", [parseWorkspaceRecoveryMutationBeforeInput(input) as unknown as JsonValue])),
    recordTurnSettled: async (input) => parseWorkspaceRecoveryTurnBindingResult(await call("recordTurnSettled", [parseWorkspaceRecoveryTurnSettledInput(input) as unknown as JsonValue])),
    recordTurnStart: async (input) => parseWorkspaceRecoveryTurnBindingResult(await call("recordTurnStart", [parseWorkspaceRecoveryTurnStartInput(input) as unknown as JsonValue])),
    retentionStatus: async (id) => parseRecoveryRetentionStatusResult(await call("retentionStatus", [text(id, "workspaceId")])),
    resolveEntry: async (input) => parseWorkspaceRecoveryEntryBindingResult(await call("resolveEntry", [parseWorkspaceRecoveryEntryTarget(input) as unknown as JsonValue])),
    setDefaultStorageLocation: async (location) => parseRecoveryStorageStatusResult(await call("setDefaultStorageLocation", [parseRecoveryStorageLocation(location) as unknown as JsonValue])),
    setRetentionPolicy: async (input) => parseRecoveryRetentionStatusResult(await call("setRetentionPolicy", [parseRecoveryRetentionPolicyInput(input) as unknown as JsonValue])),
    setStorageLocation: async (input) => parseRecoveryStorageMoveResult(await call("setStorageLocation", [parseSetRecoveryStorageLocationInput(input) as unknown as JsonValue])),
    status: async (id) => parseWorkspaceRecoveryStatusResult(await call("status", [text(id, "workspaceId")])),
    storageStatus: async (id) => parseRecoveryStorageStatusResult(await call("storageStatus", [id === undefined ? null : text(id, "workspaceId")])),
  };
};
