import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertAbsolutePathInWorkspace } from "../../workspace/path-safety.js";
import { objectPath, replaceObjectReferences, deleteObjectReferences, type SqliteDatabase } from "../../recovery/journal-catalog.js";
import { parseRecoveryState, sameState, type RecoveryFileStore, type RecoveryIdentity } from "../../recovery/journal-files.js";
import { applyIndexModes } from "./git-index-mode.js";
import { EMPTY_STATE_TRIE, trieFromEntries, trieIdentity, trieReachableNodes, trieToRecord, verifyTrie, type StateTrie, type StateTrieNode } from "./state-trie.js";
import { readRecoveryJsonAtomic, writeRecoveryJsonAtomic } from "../../recovery/locations.js";
import type {
  CommandVerificationRecord,
  DraftBaseline,
  DraftBaselinePathProvenance,
  ParentVerificationBundle,
  RecoveryState,
  ResultReviewRecord,
  ResultVerificationBundle,
  WorkingBranch,
  WorkingResult,
  WorkingStateVerifications,
} from "./types.js";
import { materializeWorkingState, type MaterializeResult } from "./materializer.js";
import { assertVirtualWriteTree } from "./virtual-write-tree.js";
import { defaultNewFileMode as resolveDefaultNewFileMode } from "./workspace-baseline.js";
import type { HostResourceOperationGate } from "../../recovery/durable-file-operation.js";

const SCHEMA_VERSION = 4;
const catalogName = (workspaceId: string): string => `${createHash("sha256").update(workspaceId).digest("hex")}.json`;

interface WorkingStateDocument {
  schemaVersion: typeof SCHEMA_VERSION;
  workspaceId: string;
  branches: Record<string, WorkingBranch>;
  draftBaselines: Record<string, DraftBaseline>;
  results: Record<string, WorkingResult>;
  verifications?: WorkingStateVerifications;
}

export interface CreateDraftBaselinePath {
  path: string;
  content: string | Buffer;
  mode?: number;
  provenance: DraftBaselinePathProvenance;
}

export interface LocalWorkingStateStorageContext {
  database: SqliteDatabase;
  fileStore: RecoveryFileStore;
  identity: RecoveryIdentity;
  resourceOperationGate: HostResourceOperationGate;
  root: string;
  collectUnreachableObjects?: () => Promise<{ byteLengthReclaimed: number; objectsDeleted: number }>;
}

export interface WorkingStateStoreOptions extends LocalWorkingStateStorageContext {
  fsPromises?: typeof fs.promises;
  pathModule?: typeof path;
}

const clone = <T>(value: T): T => structuredClone(value);
/** Whole-map content identity: the Merkle root of its state trie (D-245). */
export const treeIdentityFromStates = (states: Record<string, RecoveryState>): string =>
  trieIdentity(trieFromEntries(Object.entries(states)));
const normalizeRelative = (value: string): string => {
  const raw = value.replace(/\\/g, "/");
  const segments = raw.split("/").filter((segment) => segment && segment !== ".");
  const normalized = segments.join("/");
  if (!normalized || raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || segments.includes("..")) {
    throw new Error(`Invalid working-state path: ${value}`);
  }
  return normalized;
};

const assertNoDraftPathConflicts = (paths: readonly string[]): void => {
  const seen = new Set<string>();
  for (const file of paths) {
    if (seen.has(file)) throw new Error(`Draft baseline contains a duplicate path: ${file}`);
    seen.add(file);
  }
  for (const descendant of [...seen].sort()) {
    const parts = descendant.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const ancestor = parts.slice(0, index).join("/");
      if (!seen.has(ancestor)) continue;
      throw new Error(`Draft baseline paths contain an ancestor/descendant conflict: ${ancestor} and ${descendant}`);
    }
  }
};

type StateNodePool = Record<string, StateTrieNode>;

/**
 * Hydrate the current persisted map shape: `{trie: <root>}` references into
 * the shared `stateNodes` pool. Varin has no users who need internal-format
 * compatibility, so a flat map under schema 4 is malformed rather than a
 * hidden second representation (D-253).
 */
const parseStateMap = (value: unknown, label: string, nodes: StateNodePool): Record<string, RecoveryState> => {
  if (value && typeof value === "object" && !Array.isArray(value)
    && typeof (value as { trie?: unknown }).trie === "string") {
    const root = (value as { trie: string }).trie;
    try {
      // D-251 rework: verify node integrity before hydrating. A corrupt or
      // malformed trie must not be silently treated as an empty tree.
      verifyTrie({ root, nodes });
      const record = trieToRecord({ root, nodes });
      // Re-run the same validation a flat map would get.
      return Object.fromEntries(Object.entries(record).map(([file, state]) => [normalizeRelative(file), parseRecoveryState(state)]));
    } catch (error) {
      throw new Error(`${label} references a corrupt or missing state trie node (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  throw new Error(`${label} must reference a state trie root`);
};

const parseBranch = (
  value: unknown,
  key: string,
  workspaceId: string,
  nodes: StateNodePool,
): WorkingBranch => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Working branch ${key} is malformed`);
  const row = value as Record<string, unknown>;
  if (row.branchId !== key || row.workspaceId !== workspaceId || !Number.isSafeInteger(row.headRevision)
    || Number(row.headRevision) < 0 || typeof row.createdAt !== "string" || typeof row.updatedAt !== "string"
    || (row.baseRef !== undefined && typeof row.baseRef !== "string")
    || !Array.isArray(row.draftBasePaths) || !row.draftBasePaths.every((entry) => typeof entry === "string")
    || !Array.isArray(row.captureScopes) || !row.captureScopes.every((entry) => typeof entry === "string")) {
    throw new Error(`Working branch ${key} is malformed`);
  }
  const draftBasePaths = (row.draftBasePaths as string[]).map(normalizeRelative);
  if (new Set(draftBasePaths).size !== draftBasePaths.length) throw new Error(`Working branch ${key} draft baseline paths are malformed`);
  const captureScopes = [...new Set((row.captureScopes as string[]).map(normalizeRelative))].sort();
  const baseState = parseStateMap(row.baseState, `Working branch ${key} baseline`, nodes);
  if (draftBasePaths.some((file) => !Object.hasOwn(baseState, file))) {
    throw new Error(`Working branch ${key} does not contain every draft baseline path`);
  }
  let baseLineage: Record<number, Record<string, RecoveryState>> | undefined;
  if (row.baseLineage !== undefined) {
    if (!row.baseLineage || typeof row.baseLineage !== "object" || Array.isArray(row.baseLineage)) {
      throw new Error(`Working branch ${key} baseline lineage is malformed`);
    }
    baseLineage = Object.fromEntries(Object.entries(row.baseLineage as Record<string, unknown>).map(([gen, states]) => {
      if (!/^\d+$/.test(gen)) throw new Error(`Working branch ${key} baseline lineage generation is malformed`);
      return [Number(gen), parseStateMap(states, `Working branch ${key} baseline lineage ${gen}`, nodes)];
    }));
  }
  return {
    branchId: key,
    workspaceId,
    ...(row.baseRef === undefined ? {} : { baseRef: row.baseRef as string }),
    baseState,
    draftBasePaths,
    captureScopes,
    deltas: parseStateMap(row.deltas, `Working branch ${key} deltas`, nodes),
    headRevision: row.headRevision as number,
    writeRevision: Number.isSafeInteger(row.writeRevision) && Number(row.writeRevision) >= 0
      ? Number(row.writeRevision)
      : 0,
    ...(Number.isSafeInteger(row.baseRevision) && Number(row.baseRevision) > 0
      ? { baseRevision: Number(row.baseRevision) }
      : {}),
    ...(baseLineage ? { baseLineage } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

const parseDraftProvenance = (value: unknown, label: string): DraftBaselinePathProvenance => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed`);
  const row = value as Record<string, unknown>;
  if ((row.baseRevision !== null && typeof row.baseRevision !== "string")
    || row.encoding !== "utf-8" || typeof row.bom !== "boolean"
    || !Number.isSafeInteger(row.localEditRevision) || Number(row.localEditRevision) < 0
    || typeof row.revision !== "string" || !row.revision) throw new Error(`${label} is malformed`);
  return {
    baseRevision: row.baseRevision as string | null,
    encoding: "utf-8",
    bom: row.bom as boolean,
    localEditRevision: row.localEditRevision as number,
    revision: row.revision,
  };
};

const parseDraftBaseline = (value: unknown, key: string, workspaceId: string, nodes: StateNodePool): DraftBaseline => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Draft baseline ${key} is malformed`);
  const row = value as Record<string, unknown>;
  if (row.id !== key || row.workspaceId !== workspaceId || typeof row.createdAt !== "string"
    || !row.provenance || typeof row.provenance !== "object" || Array.isArray(row.provenance)) {
    throw new Error(`Draft baseline ${key} is malformed`);
  }
  const pathStates = parseStateMap(row.pathStates, `Draft baseline ${key} paths`, nodes);
  if (Object.values(pathStates).some((state) => state.kind !== "regular-file")) {
    throw new Error(`Draft baseline ${key} contains a non-file state`);
  }
  const provenance = Object.fromEntries(Object.entries(row.provenance as Record<string, unknown>)
    .map(([file, item]) => [normalizeRelative(file), parseDraftProvenance(item, `Draft baseline ${key} provenance for ${file}`)]));
  const statePaths = Object.keys(pathStates).sort();
  const provenancePaths = Object.keys(provenance).sort();
  if (statePaths.length !== provenancePaths.length || statePaths.some((file, index) => file !== provenancePaths[index])) {
    throw new Error(`Draft baseline ${key} provenance does not match its paths`);
  }
  assertNoDraftPathConflicts(statePaths);
  return { id: key, workspaceId, createdAt: row.createdAt, pathStates, provenance };
};

const parseResult = (value: unknown, key: string, nodes: StateNodePool): WorkingResult => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Working result ${key} is malformed`);
  const row = value as Record<string, unknown>;
  if (!Number.isSafeInteger(row.resultRevision) || Number(row.resultRevision) <= 0 || typeof row.branchId !== "string"
    || key !== `${row.branchId}@${row.resultRevision}` || !Array.isArray(row.changedPaths)
    || !(row.changedPaths as unknown[]).every((entry) => typeof entry === "string")
    || typeof row.createdAt !== "string" || !row.diffStats || typeof row.diffStats !== "object") {
    throw new Error(`Working result ${key} is malformed`);
  }
  const diff = row.diffStats as Record<string, unknown>;
  if (![diff.files, diff.insertions, diff.deletions].every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    throw new Error(`Working result ${key} diff stats are malformed`);
  }
  const changedPaths = (row.changedPaths as string[]).map(normalizeRelative);
  const baseStates = parseStateMap(row.baseStates, `Working result ${key} baseline`, nodes);
  const pathStates = parseStateMap(row.pathStates, `Working result ${key} paths`, nodes);
  if (changedPaths.some((file) => !baseStates[file] || !pathStates[file])) {
    throw new Error(`Working result ${key} does not contain every changed path`);
  }
  return {
    resultRevision: row.resultRevision as number,
    branchId: row.branchId,
    ...(typeof row.parentRef === "string" ? { parentRef: row.parentRef } : {}),
    ...(Number.isSafeInteger(row.baseRevision) && Number(row.baseRevision) >= 0
      ? { baseRevision: Number(row.baseRevision) }
      : {}),
    changedPaths,
    baseStates,
    pathStates,
    diffStats: { files: diff.files as number, insertions: diff.insertions as number, deletions: diff.deletions as number },
    createdAt: row.createdAt,
  };
};

const isSafeInt = (value: unknown): value is number => Number.isSafeInteger(value);
const isOptionalString = (value: unknown): value is string | undefined => value === undefined || typeof value === "string";

const parseCommandRecord = (value: unknown, label: string): CommandVerificationRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed`);
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.runId !== "string" || typeof row.command !== "string"
    || typeof row.cwd !== "string" || !isSafeInt(row.startedAt) || !isSafeInt(row.endedAt)
    || (row.exitCode !== null && !isSafeInt(row.exitCode)) || typeof row.cancelled !== "boolean"
    || (row.relationToPublished !== "same-run-matching-result"
      && row.relationToPublished !== "post-merge-matching-tree"
      && row.relationToPublished !== "same-run-before-publish"
      && row.relationToPublished !== "unbound"
      && row.relationToPublished !== "uncertain")
    || (row.inputChangedDuringRun !== null && typeof row.inputChangedDuringRun !== "boolean")
    || !row.inputIdentity || typeof row.inputIdentity !== "object" || Array.isArray(row.inputIdentity)) {
    throw new Error(`${label} is malformed`);
  }
  const identity = row.inputIdentity as Record<string, unknown>;
  if (identity.kind !== "tree" && identity.kind !== "published-revision" && identity.kind !== "unbound") {
    throw new Error(`${label} identity is malformed`);
  }
  const actor = row.actor && typeof row.actor === "object" && !Array.isArray(row.actor)
    ? row.actor as Record<string, unknown>
    : null;
  if (actor && (typeof actor.authorityInstanceId !== "string" || typeof actor.sessionId !== "string"
    || typeof actor.workerId !== "string" || !isSafeInt(actor.workerGeneration)
    || (actor.runId !== undefined && typeof actor.runId !== "string"))) {
    throw new Error(`${label} actor is malformed`);
  }
  const legacyIdentity = identity.kind === "published-revision" || row.relationToPublished === "same-run-before-publish";
  return {
    id: row.id,
    runId: row.runId,
    command: row.command,
    cwd: row.cwd,
    ...(row.envSummary && typeof row.envSummary === "object" && !Array.isArray(row.envSummary)
      ? { envSummary: row.envSummary as { PATH?: boolean; VIRTUAL_ENV?: string } }
      : {}),
    ...(typeof row.commandRunId === "string" ? { commandRunId: row.commandRunId } : {}),
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    exitCode: row.exitCode as number | null,
    cancelled: row.cancelled,
    ...(typeof row.outputHandle === "string" ? { outputHandle: row.outputHandle } : {}),
    ...(typeof row.outputPreview === "string" ? { outputPreview: row.outputPreview } : {}),
    actor: actor
      ? {
          authorityInstanceId: actor.authorityInstanceId as string,
          sessionId: actor.sessionId as string,
          workerId: actor.workerId as string,
          workerGeneration: actor.workerGeneration as number,
          ...(typeof actor.runId === "string" ? { runId: actor.runId } : {}),
        }
      : { authorityInstanceId: "unknown", sessionId: "unknown", workerId: "unknown", workerGeneration: 0 },
    bindingGeneration: isSafeInt(row.bindingGeneration) ? row.bindingGeneration : 0,
    inputIdentity: legacyIdentity
      ? { kind: "unbound", reason: "legacy command record has no captured tree identity" }
      : {
          kind: identity.kind as "tree" | "unbound",
          ...(typeof identity.branchId === "string" ? { branchId: identity.branchId } : {}),
          ...(typeof identity.root === "string" ? { root: identity.root } : {}),
          ...(typeof identity.startTreeHash === "string" ? { startTreeHash: identity.startTreeHash } : {}),
          ...(typeof identity.endTreeHash === "string" ? { endTreeHash: identity.endTreeHash } : {}),
          ...(typeof identity.reason === "string" ? { reason: identity.reason } : {}),
        },
    inputChangedDuringRun: legacyIdentity ? null : row.inputChangedDuringRun as boolean | null,
    relationToPublished: legacyIdentity ? "uncertain" : row.relationToPublished as CommandVerificationRecord["relationToPublished"],
  };
};

const parseChildBundle = (value: unknown, label: string): ResultVerificationBundle => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed`);
  const row = value as Record<string, unknown>;
  if (!isSafeInt(row.resultRevision) || Number(row.resultRevision) <= 0 || typeof row.branchId !== "string"
    || !isSafeInt(row.recordedAt) || (row.binding !== "bound" && row.binding !== "uncertain")
    || !Array.isArray(row.checks) || !isOptionalString(row.bindingReason) || !isOptionalString(row.resultTreeHash)) {
    throw new Error(`${label} is malformed`);
  }
  return {
    resultRevision: row.resultRevision,
    branchId: row.branchId,
    ...(typeof row.resultTreeHash === "string" ? { resultTreeHash: row.resultTreeHash } : {}),
    recordedAt: row.recordedAt,
    binding: row.binding,
    ...(typeof row.bindingReason === "string" ? { bindingReason: row.bindingReason } : {}),
    checks: row.checks.map((check, index) => parseCommandRecord(check, `${label} check ${index}`)),
  };
};

const parseParentBundle = (value: unknown, label: string): ParentVerificationBundle => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed`);
  const row = value as Record<string, unknown>;
  const bindings = new Set(["bound", "uncertain", "cannot-verify-unsaved-draft", "not-recorded", "not-integrated"]);
  if (!isSafeInt(row.mergedResultRevision) || Number(row.mergedResultRevision) <= 0 || !isSafeInt(row.recordedAt)
    || typeof row.draftUnsaved !== "boolean" || !bindings.has(row.binding as string) || !Array.isArray(row.checks)
    || !isOptionalString(row.note) || !isOptionalString(row.mergeOperationId)
    || !isOptionalString(row.parentTreeHash)
    || (row.windowOpenedAt !== undefined && !isSafeInt(row.windowOpenedAt))) {
    throw new Error(`${label} is malformed`);
  }
  return {
    mergedResultRevision: row.mergedResultRevision,
    ...(typeof row.mergeOperationId === "string" ? { mergeOperationId: row.mergeOperationId } : {}),
    ...(typeof row.parentTreeHash === "string" ? { parentTreeHash: row.parentTreeHash } : {}),
    ...(isSafeInt(row.windowOpenedAt) ? { windowOpenedAt: row.windowOpenedAt } : {}),
    recordedAt: row.recordedAt,
    draftUnsaved: row.draftUnsaved,
    binding: row.binding as ParentVerificationBundle["binding"],
    ...(typeof row.note === "string" ? { note: row.note } : {}),
    checks: row.checks.map((check, index) => parseCommandRecord(check, `${label} check ${index}`)),
  };
};

const parseReviewRecord = (value: unknown, label: string): ResultReviewRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed`);
  const row = value as Record<string, unknown>;
  const statuses = new Set(["queued", "running", "completed", "failed", "cancelled"]);
  if (!isSafeInt(row.resultRevision) || Number(row.resultRevision) <= 0 || !statuses.has(row.status as string)
    || !isSafeInt(row.recordedAt)) {
    throw new Error(`${label} is malformed`);
  }
  return {
    resultRevision: row.resultRevision,
    status: row.status as ResultReviewRecord["status"],
    recordedAt: row.recordedAt,
    ...(typeof row.reviewThreadId === "string" ? { reviewThreadId: row.reviewThreadId } : {}),
    ...(typeof row.reviewRunId === "string" ? { reviewRunId: row.reviewRunId } : {}),
    ...(typeof row.conclusion === "string" ? { conclusion: row.conclusion } : {}),
    ...(Array.isArray(row.findings)
      ? {
          findings: row.findings.map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${label} finding is malformed`);
            const finding = item as Record<string, unknown>;
            if (typeof finding.severity !== "string" || typeof finding.message !== "string") {
              throw new Error(`${label} finding is malformed`);
            }
            return {
              severity: finding.severity,
              message: finding.message,
              ...(typeof finding.file === "string" ? { file: finding.file } : {}),
              ...(isSafeInt(finding.line) ? { line: finding.line } : {}),
            };
          }),
        }
      : {}),
    ...(typeof row.error === "string" ? { error: row.error } : {}),
  };
};

const parseMap = <T>(value: unknown, label: string, parse: (item: unknown, itemLabel: string) => T): Record<string, T[]> => {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, items]) => {
    if (!Array.isArray(items)) throw new Error(`${label} ${key} must be an array`);
    return [key, items.map((item, index) => parse(item, `${label} ${key} ${index}`))];
  }));
};

const parseVerifications = (value: unknown): WorkingStateVerifications | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Working-state verifications are malformed");
  const row = value as Record<string, unknown>;
  return {
    child: parseMap(row.child, "Working-state child verifications", parseChildBundle),
    parent: parseMap(row.parent, "Working-state parent verifications", parseParentBundle),
    reviews: parseMap(row.reviews, "Working-state reviews", parseReviewRecord),
  };
};

const emptyVerifications = (): WorkingStateVerifications => ({ child: {}, parent: {}, reviews: {} });

export class WorkingStateStore {
  private readonly context: LocalWorkingStateStorageContext;
  private readonly fsPromises: typeof fs.promises;
  private readonly pathModule: typeof path;
  private readonly catalogPath: string;
  private document: WorkingStateDocument;
  private catalogPersisted: boolean;
  private defaultNewFileModeValue: number | undefined;
  /**
   * Record → built trie. Branch/result maps are replaced rather than mutated
   * in place, so identity-keyed caching is safe and serializing an unchanged
   * map costs O(1) after the first persist (D-245).
   */
  private readonly trieCache = new WeakMap<Record<string, RecoveryState>, StateTrie>();

  private constructor(options: WorkingStateStoreOptions, document: WorkingStateDocument, persisted: boolean) {
    this.context = options;
    this.fsPromises = options.fsPromises ?? fs.promises;
    this.pathModule = options.pathModule ?? path;
    this.catalogPath = this.pathModule.join(options.root, "working-state", catalogName(options.identity.workspaceId));
    this.document = document;
    this.catalogPersisted = persisted;
  }

  static async open(options: WorkingStateStoreOptions): Promise<WorkingStateStore> {
    const catalogPath = (options.pathModule ?? path).join(options.root, "working-state", catalogName(options.identity.workspaceId));
    let raw: unknown;
    let found = true;
    try {
      raw = await readRecoveryJsonAtomic(catalogPath, { fsPromises: options.fsPromises ?? fs.promises });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      found = false;
    }
    if (!found) {
      return new WorkingStateStore(options, {
        schemaVersion: SCHEMA_VERSION,
        workspaceId: options.identity.workspaceId,
        branches: {},
        draftBaselines: {},
        results: {},
      }, false);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Working-state catalog is malformed");
    const record = raw as Record<string, unknown>;
    if (record.schemaVersion !== SCHEMA_VERSION || record.workspaceId !== options.identity.workspaceId
      || !record.branches || typeof record.branches !== "object" || Array.isArray(record.branches)
      || !record.results || typeof record.results !== "object" || Array.isArray(record.results)
      || !record.draftBaselines || typeof record.draftBaselines !== "object" || Array.isArray(record.draftBaselines)
      || !record.stateNodes || typeof record.stateNodes !== "object" || Array.isArray(record.stateNodes)) {
      throw new Error("Working-state catalog schema or workspace identity is malformed");
    }
    const nodes = record.stateNodes as StateNodePool;
    const branches = Object.fromEntries(Object.entries(record.branches as Record<string, unknown>)
      .map(([key, value]) => [key, parseBranch(value, key, options.identity.workspaceId, nodes)]));
    const draftBaselines = Object.fromEntries(Object.entries(record.draftBaselines as Record<string, unknown>)
      .map(([key, value]) => [key, parseDraftBaseline(value, key, options.identity.workspaceId, nodes)]));
    const results = Object.fromEntries(Object.entries(record.results as Record<string, unknown>)
      .map(([key, value]) => [key, parseResult(value, key, nodes)]));
    const verifications = parseVerifications(record.verifications);
    return new WorkingStateStore(options, {
      schemaVersion: SCHEMA_VERSION,
      workspaceId: options.identity.workspaceId,
      branches,
      draftBaselines,
      results,
      ...(verifications ? { verifications } : {}),
    }, true);
  }

  private references(states: Record<string, RecoveryState>, prefix: string) {
    return Object.entries(states).flatMap(([file, state]) => state.kind === "regular-file"
      ? [{ slot: `${prefix}:${file}`, objectHash: state.objectHash }]
      : []);
  }

  private branchReferences(branch: WorkingBranch) {
    return [
      ...this.references(branch.baseState, "base"),
      ...this.references(branch.deltas, "delta"),
      ...Object.values(branch.baseLineage ?? {}).flatMap((states) => this.references(states, "base")),
    ];
  }

  private resultReferences(result: WorkingResult) {
    return [
      ...this.references(result.baseStates, "base"),
      ...this.references(result.pathStates, "result"),
    ];
  }

  private protectBranch(branch: WorkingBranch): void {
    replaceObjectReferences(this.context.database, branch.workspaceId, "work-branch", branch.branchId, this.branchReferences(branch));
  }

  private protectDraftBaseline(baseline: DraftBaseline): void {
    replaceObjectReferences(this.context.database, baseline.workspaceId, "draft-baseline", baseline.id, [
      ...this.references(baseline.pathStates, "draft"),
    ]);
  }

  private protectResult(result: WorkingResult): void {
    replaceObjectReferences(this.context.database, this.document.workspaceId, "thread-result", `${result.branchId}@${result.resultRevision}`, this.resultReferences(result));
  }

  private trieFor(states: Record<string, RecoveryState>): StateTrie {
    let trie = this.trieCache.get(states);
    if (!trie) {
      trie = trieFromEntries(Object.entries(states));
      this.trieCache.set(states, trie);
    }
    return trie;
  }

  /**
   * Serialized form: path maps become `{trie: <root>}` references into a shared
   * `stateNodes` pool, so identical subtrees across branches, results, and
   * draft baselines are written once. The pool is rebuilt from live roots each
   * persist, which garbage-collects orphaned nodes without a sweep.
   */
  private serializeDocument(next: WorkingStateDocument): Record<string, unknown> {
    const nodes: StateNodePool = {};
    const refOf = (states: Record<string, RecoveryState> | undefined): { trie: string } => {
      const trie = states ? this.trieFor(states) : EMPTY_STATE_TRIE;
      Object.assign(nodes, trieReachableNodes(trie));
      return { trie: trie.root };
    };
    return {
      schemaVersion: SCHEMA_VERSION,
      workspaceId: next.workspaceId,
      branches: Object.fromEntries(Object.entries(next.branches).map(([key, branch]) => [key, {
        ...branch,
        baseState: refOf(branch.baseState),
        deltas: refOf(branch.deltas),
        ...(branch.baseLineage
          ? { baseLineage: Object.fromEntries(Object.entries(branch.baseLineage).map(([gen, states]) => [gen, refOf(states)])) }
          : {}),
      }])),
      draftBaselines: Object.fromEntries(Object.entries(next.draftBaselines).map(([key, baseline]) => [key, {
        ...baseline,
        pathStates: refOf(baseline.pathStates),
      }])),
      results: Object.fromEntries(Object.entries(next.results).map(([key, result]) => [key, {
        ...result,
        baseStates: refOf(result.baseStates),
        pathStates: refOf(result.pathStates),
      }])),
      ...(next.verifications ? { verifications: next.verifications } : {}),
      stateNodes: nodes,
    };
  }

  /**
   * Structural-sharing document update (D-245): copies only the containers
   * being replaced; unchanged branch/result/baseline objects — and their path
   * maps — keep their references instead of a per-write deep clone.
   */
  private nextDocument(): WorkingStateDocument {
    const d = this.document;
    return {
      ...d,
      branches: { ...d.branches },
      draftBaselines: { ...d.draftBaselines },
      results: { ...d.results },
      ...(d.verifications
        ? { verifications: {
            child: { ...d.verifications.child },
            parent: { ...d.verifications.parent },
            reviews: { ...d.verifications.reviews },
          } }
        : {}),
    };
  }

  private async persist(
    next: WorkingStateDocument,
    protect: () => void,
    references: Array<{ objectHash: string }> = [],
  ): Promise<void> {
    const pendingOwner = references.length > 0 ? randomUUID() : null;
    if (pendingOwner) {
      const hashes = [...new Set(references.map((reference) => reference.objectHash))];
      this.context.database.transaction(() => replaceObjectReferences(
        this.context.database, this.document.workspaceId, "working-state-write", pendingOwner,
        hashes.map((hash) => ({ slot: hash, objectHash: hash })),
      )).immediate();
    }
    // Old owners stay intact until the atomic catalog is durable. Pending
    // ownership protects new bytes even if rename succeeds but its fsync fails.
    await writeRecoveryJsonAtomic(this.catalogPath, this.serializeDocument(next), { fsPromises: this.fsPromises, pathModule: this.pathModule });
    this.document = next;
    this.catalogPersisted = true;
    this.context.database.transaction(() => {
      protect();
      if (pendingOwner) deleteObjectReferences(this.context.database, this.document.workspaceId, "working-state-write", pendingOwner);
    }).immediate();
  }

  /** Deletion publishes metadata before releasing the content it used to own. */
  private async persistRemoval(next: WorkingStateDocument, release: () => void): Promise<void> {
    await writeRecoveryJsonAtomic(this.catalogPath, this.serializeDocument(next), { fsPromises: this.fsPromises, pathModule: this.pathModule });
    this.document = next;
    this.catalogPersisted = true;
    this.context.database.transaction(release).immediate();
  }

  /** Repair derived references under the owning storage's exclusive lease. */
  async reconcileObjectReferences(): Promise<void> {
    const { database } = this.context;
    const workspaceId = this.document.workspaceId;
    if (!this.catalogPersisted) {
      const retained = database.prepare(`SELECT 1 FROM object_references
        WHERE workspace_id = ? AND owner_kind IN ('work-branch', 'draft-baseline', 'thread-result', 'working-state-write') LIMIT 1`).get(workspaceId);
      if (retained) throw new Error("Working-state catalog is missing while its content is still retained");
      return;
    }
    const expected = new Map<string, string>();
    const add = (kind: string, id: string, refs: Array<{ slot: string; objectHash: string }>) => {
      for (const ref of refs) expected.set(JSON.stringify([kind, id, ref.slot]), ref.objectHash);
    };
    for (const branch of Object.values(this.document.branches)) add("work-branch", branch.branchId, this.branchReferences(branch));
    for (const baseline of Object.values(this.document.draftBaselines)) add("draft-baseline", baseline.id, this.references(baseline.pathStates, "draft"));
    for (const result of Object.values(this.document.results)) add("thread-result", `${result.branchId}@${result.resultRevision}`, this.resultReferences(result));
    const current = database.prepare(`SELECT owner_kind, owner_id, slot, object_hash FROM object_references
      WHERE workspace_id = ? AND owner_kind IN ('work-branch', 'draft-baseline', 'thread-result', 'working-state-write')`).all(workspaceId) as Array<{
        owner_kind: string; owner_id: string; slot: string; object_hash: string;
      }>;
    if (current.length === expected.size && current.every((ref) =>
      expected.get(JSON.stringify([ref.owner_kind, ref.owner_id, ref.slot])) === ref.object_hash)) return;
    // A previous atomic rename may have succeeded while fsync reported failure.
    // Make the observed catalog durable before discarding either side's refs.
    await writeRecoveryJsonAtomic(this.catalogPath, this.serializeDocument(this.document), { fsPromises: this.fsPromises, pathModule: this.pathModule });
    database.transaction(() => {
      database.prepare(`DELETE FROM object_references
        WHERE workspace_id = ? AND owner_kind IN ('work-branch', 'draft-baseline', 'thread-result', 'working-state-write')`).run(workspaceId);
      for (const branch of Object.values(this.document.branches)) this.protectBranch(branch);
      for (const baseline of Object.values(this.document.draftBaselines)) this.protectDraftBaseline(baseline);
      for (const result of Object.values(this.document.results)) this.protectResult(result);
    }).immediate();
  }

  async putObject(bytes: Buffer): Promise<{ hash: string; byteLength: number }> {
    const hash = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
    const target = objectPath(this.context.root, hash);
    await this.fsPromises.mkdir(this.pathModule.dirname(target), { recursive: true, mode: 0o700 });
    try {
      const existing = await this.fsPromises.readFile(target);
      const actual = `sha256-${createHash("sha256").update(existing).digest("hex")}`;
      if (actual !== hash) throw new Error(`Working-state object is corrupt: ${hash}`);
      return { hash, byteLength: bytes.length };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const staging = this.pathModule.join(this.context.root, "staging", `${randomUUID()}.working-object`);
    await this.fsPromises.mkdir(this.pathModule.dirname(staging), { recursive: true, mode: 0o700 });
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await this.fsPromises.open(staging, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await this.fsPromises.rename(staging, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.fsPromises.rm(staging, { force: true });
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await this.fsPromises.rm(staging, { force: true }).catch(() => undefined);
    }
    return { hash, byteLength: bytes.length };
  }

  async getObject(hash: string): Promise<Buffer | null> {
    try {
      const bytes = await this.fsPromises.readFile(objectPath(this.context.root, hash));
      const actual = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
      if (actual !== hash) throw new Error(`Working-state object is corrupt: ${hash}`);
      return bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async getObjectSlice(
    hash: string,
    expectedByteLength: number,
    offset: number,
    length: number,
  ): Promise<Buffer | null> {
    const start = Math.max(0, Math.floor(offset));
    const requested = Math.max(0, Math.floor(length));
    let handle: fs.promises.FileHandle | null = null;
    try {
      const target = objectPath(this.context.root, hash);
      handle = await this.fsPromises.open(target, "r");
      const stat = await handle.stat();
      if (stat.size !== expectedByteLength) {
        throw new Error(`Working-state object length is corrupt: ${hash}`);
      }
      if (start >= stat.size || requested === 0) return Buffer.alloc(0);
      const bytes = Buffer.alloc(Math.min(requested, stat.size - start));
      const result = await handle.read(bytes, 0, bytes.byteLength, start);
      return bytes.subarray(0, result.bytesRead);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  getBranch(branchId: string): WorkingBranch | null {
    const branch = this.document.branches[branchId];
    return branch ? clone(branch) : null;
  }

  getDraftBaselineRecord(id: string): DraftBaseline | null {
    const baseline = this.document.draftBaselines[id];
    return baseline ? clone(baseline) : null;
  }

  async getDraftBaseline(id: string): Promise<DraftBaseline | null> {
    const baseline = this.document.draftBaselines[id];
    if (!baseline) return null;
    for (const [file, state] of Object.entries(baseline.pathStates)) {
      if (state.kind !== "regular-file" || await this.getObject(state.objectHash) === null) {
        throw new Error(`Draft baseline ${id} content is missing for ${file}`);
      }
    }
    return clone(baseline);
  }

  listResults(branchId?: string): WorkingResult[] {
    return Object.values(this.document.results)
      .filter((result) => branchId === undefined || result.branchId === branchId)
      .map((result) => clone(result));
  }

  getResult(branchId: string, revision: number): WorkingResult | null {
    const result = this.document.results[`${branchId}@${revision}`];
    return result ? clone(result) : null;
  }

  getChildVerification(threadId: string, resultRevision: number): ResultVerificationBundle | null {
    const match = this.document.verifications?.child[threadId]?.find((bundle) => bundle.resultRevision === resultRevision);
    return match ? clone(match) : null;
  }

  listChildVerifications(threadId: string): ResultVerificationBundle[] {
    return (this.document.verifications?.child[threadId] ?? []).map((bundle) => clone(bundle));
  }

  getParentVerification(threadId: string, mergedResultRevision?: number): ParentVerificationBundle | null {
    const list = this.document.verifications?.parent[threadId] ?? [];
    const match = mergedResultRevision === undefined
      ? list.reduce<ParentVerificationBundle | undefined>((latest, bundle) => (
          !latest || (bundle.windowOpenedAt ?? bundle.recordedAt) >= (latest.windowOpenedAt ?? latest.recordedAt) ? bundle : latest
        ), undefined)
      : list.find((bundle) => bundle.mergedResultRevision === mergedResultRevision);
    return match ? clone(match) : null;
  }

  listParentVerifications(threadId: string): ParentVerificationBundle[] {
    return (this.document.verifications?.parent[threadId] ?? []).map((bundle) => clone(bundle));
  }

  getReviewRecord(threadId: string, resultRevision: number): ResultReviewRecord | null {
    const match = this.document.verifications?.reviews[threadId]?.find((record) => record.resultRevision === resultRevision);
    return match ? clone(match) : null;
  }

  listReviewRecords(threadId: string): ResultReviewRecord[] {
    return (this.document.verifications?.reviews[threadId] ?? []).map((record) => clone(record));
  }

  async putChildVerification(threadId: string, bundle: ResultVerificationBundle): Promise<void> {
    const next = this.nextDocument();
    const verifications = next.verifications ?? emptyVerifications();
    const current = verifications.child[threadId] ?? [];
    verifications.child[threadId] = [
      ...current.filter((item) => item.resultRevision !== bundle.resultRevision),
      clone(bundle),
    ].sort((left, right) => left.resultRevision - right.resultRevision);
    next.verifications = verifications;
    await this.persist(next, () => undefined);
  }

  async putParentVerification(threadId: string, bundle: ParentVerificationBundle): Promise<void> {
    const next = this.nextDocument();
    const verifications = next.verifications ?? emptyVerifications();
    const current = verifications.parent[threadId] ?? [];
    verifications.parent[threadId] = [
      ...current.filter((item) => item.mergedResultRevision !== bundle.mergedResultRevision),
      clone(bundle),
    ].sort((left, right) => left.mergedResultRevision - right.mergedResultRevision);
    next.verifications = verifications;
    await this.persist(next, () => undefined);
  }

  async putReviewRecord(threadId: string, record: ResultReviewRecord): Promise<void> {
    const next = this.nextDocument();
    const verifications = next.verifications ?? emptyVerifications();
    const current = verifications.reviews[threadId] ?? [];
    verifications.reviews[threadId] = [
      ...current.filter((item) => item.resultRevision !== record.resultRevision),
      clone(record),
    ].sort((left, right) => left.resultRevision - right.resultRevision);
    next.verifications = verifications;
    await this.persist(next, () => undefined);
  }

  /**
   * Baseline map a result was published against. After a rebase the branch's
   * baseState moves forward, so older results resolve through baseLineage
   * (generation 0 is the original baseline, which also covers results
   * persisted before the field existed).
   */
  private baseForResult(branch: WorkingBranch, result: WorkingResult): Record<string, RecoveryState> | null {
    const generation = result.baseRevision ?? 0;
    if (generation === (branch.baseRevision ?? 0)) return branch.baseState;
    return branch.baseLineage?.[generation] ?? null;
  }

  resultState(branchId: string, revision: number): Record<string, RecoveryState> | null {
    const branch = this.document.branches[branchId];
    const result = this.document.results[`${branchId}@${revision}`];
    if (!branch || !result) return null;
    const base = this.baseForResult(branch, result);
    if (!base) return null;
    return { ...clone(base), ...clone(result.pathStates) };
  }

  /**
   * Branch view by revision: undefined = current head (base plus deltas),
   * 0 = the fixed baseline only (kernel revision-0 semantics), >0 = the
   * published result's full state resolved against its own baseline.
   */
  effectiveState(branchId: string, revision?: number): Record<string, RecoveryState> | null {
    const branch = this.document.branches[branchId];
    if (!branch) return null;
    if (revision !== undefined && revision > 0) return this.resultState(branchId, revision);
    if (revision === 0) return clone(branch.baseState);
    return { ...clone(branch.baseState), ...clone(branch.deltas) };
  }

  branchWriteRevision(branchId: string): number | null {
    const branch = this.document.branches[branchId];
    return branch ? branch.writeRevision ?? 0 : null;
  }

  /**
   * Copy only the part of a live/result tree needed by a scoped read. The
   * catalog is already memory-resident, so this still walks flat metadata, but
   * it avoids cloning unrelated states and can stop promptly on cancellation.
   */
  effectiveStateSlice(
    branchId: string,
    prefixes: readonly string[],
    revision?: number,
    options?: { signal?: AbortSignal; deadlineAt?: number },
  ): Record<string, RecoveryState> | null {
    const branch = this.document.branches[branchId];
    if (!branch) return null;
    const result = revision !== undefined && revision > 0
      ? this.document.results[`${branchId}@${revision}`]
      : undefined;
    if (revision !== undefined && revision > 0 && !result) return null;
    const overlayBase = result ? this.baseForResult(branch, result) : branch.baseState;
    if (!overlayBase) return null;
    const overlay = revision === 0 ? {} : (result?.pathStates ?? branch.deltas);
    const roots = (prefixes.length > 0 ? prefixes : [""]).map((value) => {
      const raw = value.replace(/\\/g, "/").replace(/^\.\//, "");
      if (!raw || raw === ".") return "";
      const segments = raw.split("/").filter((segment) => segment && segment !== ".");
      if (raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || segments.includes("..")) {
        throw new Error(`Invalid working-state scope: ${value}`);
      }
      return segments.join("/");
    });
    const relevant = (file: string): boolean => roots.some((root) => (
      !root || file === root || file.startsWith(`${root}/`) || root.startsWith(`${file}/`)
    ));
    const check = (): void => {
      options?.signal?.throwIfAborted();
      if (options?.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
        throw new DOMException("Explore query deadline exceeded", "AbortError");
      }
    };
    const states: Record<string, RecoveryState> = {};
    const copyRelevant = (source: Record<string, RecoveryState>): void => {
      for (const [file, state] of Object.entries(source)) {
        check();
        if (relevant(file)) states[file] = clone(state);
      }
    };
    copyRelevant(overlayBase);
    copyRelevant(overlay);
    check();
    return states;
  }

  pathOrigin(branchId: string, file: string): "base" | "delta" | "draft-base" | null {
    const branch = this.document.branches[branchId];
    if (!branch) return null;
    const normalized = normalizeRelative(file);
    if (Object.hasOwn(branch.deltas, normalized)) return "delta";
    if (branch.draftBasePaths.includes(normalized)) return "draft-base";
    if (Object.hasOwn(branch.baseState, normalized)) return "base";
    return null;
  }

  resultTreeIdentity(branchId: string, revision: number): string | null {
    const states = this.resultState(branchId, revision);
    return states ? treeIdentityFromStates(states) : null;
  }

  async captureBranchCandidateIdentity(branchId: string, directory: string, changedPaths: string[]): Promise<string | null> {
    const branch = this.document.branches[branchId];
    if (!branch) return null;
    const candidates = await this.branchCaptureCandidates(branch, directory, changedPaths);
    const captured: Record<string, RecoveryState> = {};
    const identity = { ...this.context.identity, canonicalRoot: directory };
    for (const file of candidates) {
      captured[file] = (await this.context.fileStore.captureState(identity, this.context.root, file, { store: false })).state;
    }
    const effective = clone(branch.baseState);
    for (const [file, state] of Object.entries(captured)) {
      if (state.kind === "missing" && !Object.hasOwn(branch.baseState, file)) delete effective[file];
      else effective[file] = state;
    }
    return treeIdentityFromStates(effective);
  }

  async captureSeededPathIdentity(directory: string, changedPaths: string[], seed: string): Promise<string> {
    const candidates = [...new Set(changedPaths.map(normalizeRelative).flatMap((file) => {
      const paths = [file];
      let parent = this.pathModule.posix.dirname(file);
      while (parent !== "." && parent !== "/") {
        paths.push(parent);
        parent = this.pathModule.posix.dirname(parent);
      }
      return paths;
    }))].sort();
    const captured: Record<string, RecoveryState> = {};
    const identity = { ...this.context.identity, canonicalRoot: directory };
    for (const file of candidates) {
      captured[file] = (await this.context.fileStore.captureState(identity, this.context.root, file, { store: false })).state;
    }
    return `sha256-${createHash("sha256").update(seed).update("\0").update(treeIdentityFromStates(captured)).digest("hex")}`;
  }

  async createBranch(
    workspaceId: string,
    branchId: string,
    baseState: Record<string, RecoveryState>,
    baseRef?: string,
    draftBasePaths: string[] = [],
    captureScopes: string[] = [],
  ): Promise<WorkingBranch> {
    if (workspaceId !== this.document.workspaceId) throw new Error(`Working-state workspace mismatch: ${workspaceId}`);
    const existing = this.document.branches[branchId];
    if (existing) return clone(existing);
    const normalizedDraftBasePaths = [...new Set(draftBasePaths.map(normalizeRelative))].sort();
    if (normalizedDraftBasePaths.some((file) => !Object.hasOwn(baseState, file))) {
      throw new Error(`Working branch ${branchId} does not contain every draft baseline path`);
    }
    const now = new Date().toISOString();
    const branch: WorkingBranch = {
      branchId,
      workspaceId,
      ...(baseRef ? { baseRef } : {}),
      baseState: clone(baseState),
      draftBasePaths: normalizedDraftBasePaths,
      captureScopes: [...new Set(captureScopes.map(normalizeRelative))].sort(),
      deltas: {},
      headRevision: 0,
      writeRevision: 0,
      createdAt: now,
      updatedAt: now,
    };
    const next = this.nextDocument();
    next.branches[branchId] = branch;
    await this.persist(next, () => this.protectBranch(branch), this.branchReferences(branch));
    return clone(branch);
  }

  async createDraftBaseline(workspaceId: string, paths: readonly CreateDraftBaselinePath[]): Promise<DraftBaseline> {
    if (workspaceId !== this.document.workspaceId) throw new Error(`Working-state workspace mismatch: ${workspaceId}`);
    const id = `draft-${randomUUID()}`;
    const pathStates: Record<string, RecoveryState> = {};
    const provenance: Record<string, DraftBaselinePathProvenance> = {};
    const normalizedPaths = paths.map((pathInput) => ({ ...pathInput, path: normalizeRelative(pathInput.path) }));
    assertNoDraftPathConflicts(normalizedPaths.map((pathInput) => pathInput.path));
    for (const pathInput of normalizedPaths) {
      const file = pathInput.path;
      const bytes = typeof pathInput.content === "string" ? Buffer.from(pathInput.content, "utf8") : pathInput.content;
      const object = await this.putObject(bytes);
      pathStates[file] = {
        kind: "regular-file",
        objectHash: object.hash,
        byteLength: object.byteLength,
        ...(pathInput.mode === undefined ? {} : { mode: pathInput.mode }),
      };
      provenance[file] = clone(pathInput.provenance);
    }
    const baseline: DraftBaseline = {
      id,
      workspaceId,
      createdAt: new Date().toISOString(),
      pathStates,
      provenance,
    };
    const next = this.nextDocument();
    next.draftBaselines[id] = baseline;
    await this.persist(next, () => this.protectDraftBaseline(baseline), this.references(baseline.pathStates, "draft"));
    return clone(baseline);
  }

  async publishStates(branchId: string, capturedState: Record<string, RecoveryState>, knownChangedPaths?: string[]): Promise<WorkingResult> {
    const branch = this.document.branches[branchId];
    if (!branch) throw new Error(`Working branch not found: ${branchId}`);
    const stampedState: Record<string, RecoveryState> = {};
    for (const [file, state] of Object.entries(capturedState)) {
      const normalized = normalizeRelative(file);
      stampedState[normalized] = await this.stampRegularFileState(state, branch.baseState[normalized]);
    }
    const candidates = knownChangedPaths
      ? [...new Set(knownChangedPaths.map(normalizeRelative))]
      : [...new Set([...Object.keys(branch.baseState), ...Object.keys(stampedState)])];
    const changedPaths = candidates.filter((file) => !sameState(
      branch.baseState[file] ?? { kind: "missing" },
      stampedState[file] ?? { kind: "missing" },
    )).sort();
    const baseStates: Record<string, RecoveryState> = Object.fromEntries(changedPaths.map((file) => [
      file,
      branch.baseState[file] ?? { kind: "missing" as const },
    ]));
    const pathStates: Record<string, RecoveryState> = Object.fromEntries(changedPaths.map((file) => [
      file,
      stampedState[file] ?? { kind: "missing" as const },
    ]));
    const previous = this.document.results[`${branchId}@${branch.headRevision}`];
    if (previous && previous.changedPaths.length === changedPaths.length
      && previous.changedPaths.every((file, index) => file === changedPaths[index]
        && sameState(previous.baseStates[file]!, baseStates[file]!)
        && sameState(previous.pathStates[file]!, pathStates[file]!))) {
      return clone(previous);
    }
    const revision = branch.headRevision + 1;
    const result: WorkingResult = {
      resultRevision: revision,
      branchId,
      ...(branch.baseRef ? { parentRef: branch.baseRef } : {}),
      changedPaths,
      baseStates,
      pathStates,
      diffStats: { files: changedPaths.length, insertions: 0, deletions: 0 },
      createdAt: new Date().toISOString(),
      baseRevision: branch.baseRevision ?? 0,
    };
    const next = this.nextDocument();
    // pathStates is shared with branch.deltas: identical maps collapse to one
    // trie and one node-pool entry at persist time (D-245).
    next.branches[branchId] = { ...branch, deltas: pathStates, headRevision: revision, updatedAt: result.createdAt };
    next.results[`${branchId}@${revision}`] = result;
    await this.persist(next, () => {
      this.protectBranch(next.branches[branchId]!);
      this.protectResult(result);
    }, [...this.branchReferences(next.branches[branchId]!), ...this.resultReferences(result)]);
    return clone(result);
  }

  async publishHeadResult(branchId: string): Promise<WorkingResult> {
    const states = this.effectiveState(branchId);
    if (!states) throw new Error(`Working branch not found: ${branchId}`);
    return this.publishStates(branchId, states);
  }

  async commitVirtualWrites(
    branchId: string,
    expectedWriteRevision: number,
    files: Record<string, RecoveryState>,
  ): Promise<{ status: "committed"; writeRevision: number } | { status: "conflict"; writeRevision: number }> {
    const branch = this.document.branches[branchId];
    if (!branch) throw new Error(`Working branch not found: ${branchId}`);
    const current = branch.writeRevision ?? 0;
    if (current !== expectedWriteRevision) {
      return { status: "conflict", writeRevision: current };
    }
    const live = this.effectiveState(branchId) ?? {};
    const stampedFiles: Record<string, RecoveryState> = {};
    for (const [file, next] of Object.entries(files)) {
      const normalized = normalizeRelative(file);
      stampedFiles[normalized] = await this.stampRegularFileState(next, live[normalized]);
    }
    assertVirtualWriteTree(live, stampedFiles);
    const deltas = { ...branch.deltas };
    for (const [file, next] of Object.entries(stampedFiles)) {
      const normalized = normalizeRelative(file);
      if (next.kind === "missing" && !Object.hasOwn(branch.baseState, normalized)) {
        delete deltas[normalized];
      } else {
        deltas[normalized] = clone(next);
      }
      if (next.kind === "missing") continue;
      let parent = this.pathModule.posix.dirname(normalized);
      while (parent && parent !== "." && parent !== "/") {
        const ancestor = deltas[parent] ?? branch.baseState[parent];
        if (ancestor?.kind === "missing") {
          if (Object.hasOwn(branch.baseState, parent) && branch.baseState[parent]!.kind !== "missing") {
            delete deltas[parent];
          } else {
            deltas[parent] = { kind: "directory" };
          }
        }
        parent = this.pathModule.posix.dirname(parent);
      }
    }
    const writeRevision = current + 1;
    const nextDocument = this.nextDocument();
    nextDocument.branches[branchId] = {
      ...branch,
      deltas,
      writeRevision,
      updatedAt: new Date().toISOString(),
    };
    await this.persist(nextDocument, () => this.protectBranch(nextDocument.branches[branchId]!), this.branchReferences(nextDocument.branches[branchId]!));
    return { status: "committed", writeRevision };
  }

  /**
   * Atomically move the branch baseline to `baseState` while replacing the
   * delta set with `changes` (complete set, not a patch). The superseded
   * baseline is kept in baseLineage so older published results still resolve
   * against the base they were published on.
   */
  async rebaseBranch(
    branchId: string,
    expectedWriteRevision: number,
    rebase: {
      baseRef: string;
      parentRef?: string;
      baseState?: Record<string, RecoveryState>;
      changes: Record<string, RecoveryState>;
    },
  ): Promise<{ status: "committed"; writeRevision: number } | { status: "conflict"; writeRevision: number }> {
    const branch = this.document.branches[branchId];
    if (!branch) throw new Error(`Working branch not found: ${branchId}`);
    const current = branch.writeRevision ?? 0;
    if (current !== expectedWriteRevision) {
      return { status: "conflict", writeRevision: current };
    }
    if (!rebase.baseState) throw new Error(`Rebase of ${branchId} requires the resolved base state map`);
    const baseState: Record<string, RecoveryState> = {};
    for (const [file, state] of Object.entries(rebase.baseState)) {
      baseState[normalizeRelative(file)] = clone(state);
    }
    if (branch.draftBasePaths.some((file) => !Object.hasOwn(baseState, file))) {
      throw new Error(`Rebase of ${branchId} would drop draft baseline paths`);
    }
    const deltas: Record<string, RecoveryState> = {};
    for (const [file, next] of Object.entries(rebase.changes)) {
      const normalized = normalizeRelative(file);
      deltas[normalized] = clone(next);
      if (next.kind === "missing") continue;
      let parent = this.pathModule.posix.dirname(normalized);
      while (parent && parent !== "." && parent !== "/") {
        if (!deltas[parent] && !baseState[parent]) {
          deltas[parent] = { kind: "directory" };
        }
        parent = this.pathModule.posix.dirname(parent);
      }
    }
    const writeRevision = current + 1;
    const baseRevision = (branch.baseRevision ?? 0) + 1;
    const nextDocument = this.nextDocument();
    nextDocument.branches[branchId] = {
      ...branch,
      baseRef: rebase.parentRef ?? rebase.baseRef,
      baseState,
      baseRevision,
      baseLineage: {
        ...(branch.baseLineage ?? {}),
        [branch.baseRevision ?? 0]: branch.baseState,
      },
      deltas,
      writeRevision,
      updatedAt: new Date().toISOString(),
    };
    await this.persist(nextDocument, () => this.protectBranch(nextDocument.branches[branchId]!), this.branchReferences(nextDocument.branches[branchId]!));
    return { status: "committed", writeRevision };
  }

  async commitVirtualWrite(
    branchId: string,
    expectedWriteRevision: number,
    file: string,
    next: RecoveryState,
  ): Promise<{ status: "committed"; writeRevision: number } | { status: "conflict"; writeRevision: number }> {
    return this.commitVirtualWrites(branchId, expectedWriteRevision, { [file]: next });
  }

  async publishDirectoryResult(
    branchId: string,
    directory: string,
    changedPaths?: string[],
    options?: {
      indexModes?: Map<string, string> | Record<string, string> | undefined;
      validateFixedSource?: () => Promise<boolean>;
    },
  ): Promise<WorkingResult> {
    if (!changedPaths) {
      const captured = await this.captureDirectory(directory, undefined, options);
      if (options?.validateFixedSource && !await options.validateFixedSource()) {
        throw new Error("Working-state source changed while it was being captured");
      }
      return this.publishStates(branchId, captured);
    }
    const branch = this.document.branches[branchId];
    if (!branch) throw new Error(`Working branch not found: ${branchId}`);
    const candidates = await this.branchCaptureCandidates(branch, directory, changedPaths);
    const captured = await this.captureDirectory(directory, candidates, options);
    if (options?.validateFixedSource && !await options.validateFixedSource()) {
      throw new Error("Working-state source changed while it was being captured");
    }
    return this.publishStates(branchId, captured, candidates);
  }

  private async branchCaptureCandidates(branch: WorkingBranch, directory: string, changedPaths: string[]): Promise<string[]> {
    const changed = changedPaths.map(normalizeRelative);
    const ancestors = changed.flatMap((file) => {
      const result: string[] = [];
      let parent = this.pathModule.posix.dirname(file);
      while (parent !== "." && parent !== "/") {
        result.push(parent);
        parent = this.pathModule.posix.dirname(parent);
      }
      return result;
    });
    const currentPaths = await this.scanCaptureScopes(directory, branch.captureScopes);
    const scopePaths = branch.captureScopes.flatMap((scope) => [
      scope,
      ...Object.keys(branch.baseState).filter((file) => file === scope || file.startsWith(`${scope}/`)),
      ...currentPaths.filter((file) => file === scope || file.startsWith(`${scope}/`)),
    ]);
    return [...new Set([
      ...branch.draftBasePaths,
      ...scopePaths,
      ...Object.keys(branch.deltas),
      ...changed,
      ...ancestors,
    ])];
  }

  async materializeResult(branchId: string, revision: number, directory: string): Promise<MaterializeResult> {
    const states = this.resultState(branchId, revision);
    if (!states) throw new Error(`Working result not found: ${branchId}@${revision}`);
    return materializeWorkingState({
      targetDir: directory,
      states,
      readContent: async (state) => state.kind === "regular-file" ? this.getObject(state.objectHash) : null,
      objectPathFor: (state) => state.kind === "regular-file" ? objectPath(this.context.root, state.objectHash) : null,
      cleanUnreferenced: true,
      fsPromises: this.fsPromises,
      pathModule: this.pathModule,
    });
  }

  async materializeStates(states: Record<string, RecoveryState>, directory: string): Promise<MaterializeResult> {
    return materializeWorkingState({
      targetDir: directory,
      states,
      readContent: async (state) => state.kind === "regular-file" ? this.getObject(state.objectHash) : null,
      objectPathFor: (state) => state.kind === "regular-file" ? objectPath(this.context.root, state.objectHash) : null,
      fsPromises: this.fsPromises,
      pathModule: this.pathModule,
    });
  }

  async directoryMatchesResult(branchId: string, revision: number, directory: string): Promise<boolean> {
    const expected = this.resultState(branchId, revision);
    if (!expected) return false;
    const files = await this.scanDirectoryRelative(directory);
    const candidates = new Set([...Object.keys(expected), ...files]);
    const identity = { ...this.context.identity, canonicalRoot: directory };
    for (const file of candidates) {
      const actual = (await this.context.fileStore.captureState(identity, this.context.root, file, { store: false })).state;
      if (!sameState(actual, expected[file] ?? { kind: "missing" })) return false;
    }
    return true;
  }

  async deleteBranch(branchId: string): Promise<void> {
    if (!this.document.branches[branchId]) return;
    const next = this.nextDocument();
    delete next.branches[branchId];
    await this.persistRemoval(next, () => deleteObjectReferences(this.context.database, this.document.workspaceId, "work-branch", branchId));
  }

  async deleteDraftBaseline(id: string): Promise<void> {
    if (!this.document.draftBaselines[id]) return;
    const next = this.nextDocument();
    delete next.draftBaselines[id];
    await this.persistRemoval(next, () => deleteObjectReferences(this.context.database, this.document.workspaceId, "draft-baseline", id));
  }

  async deleteResult(branchId: string, revision: number): Promise<void> {
    await this.deleteResults(branchId, [revision]);
  }

  async deleteResults(branchId: string, revisions: readonly number[]): Promise<number[]> {
    const requested = [...new Set(revisions)];
    if (requested.some((revision) => !Number.isSafeInteger(revision) || revision < 1)) {
      throw new Error("Result revisions must be positive safe integers");
    }
    if (requested.length === 0) return [];
    const next = this.nextDocument();
    const removed = requested.filter((revision) => Object.hasOwn(next.results, `${branchId}@${revision}`));
    for (const revision of removed) delete next.results[`${branchId}@${revision}`];
    const release = () => {
      for (const revision of requested) {
        deleteObjectReferences(this.context.database, this.document.workspaceId, "thread-result", `${branchId}@${revision}`);
      }
    };
    // Retry also re-publishes the catalog: the prior request may have completed
    // rename but failed before durable metadata/reference cleanup was confirmed.
    await this.persistRemoval(next, release);
    return removed;
  }

  async captureDirectory(
    directory: string,
    relativePaths?: string[],
    options?: {
      signal?: AbortSignal;
      onProgress?: (done: number, total: number) => void;
      store?: boolean;
      /** Git index modes for tracked paths; restores executable intent on platforms that cannot stat it (D-243). */
      indexModes?: Map<string, string> | Record<string, string> | undefined;
    },
  ): Promise<Record<string, RecoveryState>> {
    const result: Record<string, RecoveryState> = {};
    const files = relativePaths?.map(normalizeRelative) ?? await this.scanDirectoryRelative(directory);
    const identity = { ...this.context.identity, canonicalRoot: directory };
    let done = 0;
    for (const file of files) {
      if (options?.signal?.aborted) {
        throw new DOMException("Workspace baseline capture aborted", "AbortError");
      }
      const captured = await this.context.fileStore.captureState(identity, this.context.root, file, { store: options?.store ?? true });
      result[file] = captured.state;
      done += 1;
      options?.onProgress?.(done, files.length);
    }
    return applyIndexModes(result, options?.indexModes);
  }

  async listCaptureScopePaths(directory: string, scopes: readonly string[]): Promise<string[]> {
    return this.scanCaptureScopes(directory, scopes);
  }

  async listWorkspaceBaselinePaths(directory: string): Promise<string[]> {
    return this.scanDirectoryRelative(directory);
  }

  private async defaultNewFileMode(): Promise<number> {
    if (this.defaultNewFileModeValue === undefined) {
      this.defaultNewFileModeValue = resolveDefaultNewFileMode();
    }
    return this.defaultNewFileModeValue;
  }

  private async stampRegularFileState(state: RecoveryState, existing?: RecoveryState): Promise<RecoveryState> {
    if (state.kind !== "regular-file" || state.mode !== undefined) return state;
    if (existing?.kind === "regular-file" && existing.mode !== undefined) {
      return { ...state, mode: existing.mode };
    }
    if (!existing || existing.kind === "missing") {
      return { ...state, mode: await this.defaultNewFileMode() };
    }
    return state;
  }

  private async scanDirectoryRelative(directory: string, base = directory): Promise<string[]> {
    const result: string[] = [];
    const entries = await this.fsPromises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".varin") continue;
      const absolute = this.pathModule.join(directory, entry.name);
      const relative = normalizeRelative(this.pathModule.relative(base, absolute));
      if (entry.isDirectory()) {
        result.push(relative);
        result.push(...await this.scanDirectoryRelative(absolute, base));
      } else {
        result.push(relative);
      }
    }
    return result.sort();
  }

  private async scanCaptureScopes(directory: string, scopes: readonly string[]): Promise<string[]> {
    const normalizedScopes = [...new Set(scopes.map(normalizeRelative))].sort();
    const minimalScopes = normalizedScopes.filter((scope, index) => (
      !normalizedScopes.slice(0, index).some((parent) => scope.startsWith(`${parent}/`))
    ));
    const result = new Set<string>();
    const visit = async (relative: string): Promise<void> => {
      const absolute = this.pathModule.resolve(directory, ...relative.split("/"));
      await assertAbsolutePathInWorkspace(absolute, {
        root: directory,
        fsPromises: this.fsPromises,
        pathModule: this.pathModule,
        allowMissing: true,
      });
      let stat: fs.Stats;
      try {
        stat = await this.fsPromises.lstat(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      result.add(relative);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      const entries = await this.fsPromises.readdir(absolute, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ".git" || entry.name === ".varin") continue;
        await visit(normalizeRelative(`${relative}/${entry.name}`));
      }
    };
    for (const scope of minimalScopes) await visit(scope);
    return [...result].sort();
  }
}
