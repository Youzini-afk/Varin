import { runKernelCompute } from "./compute-runner.js";
import type { WorkingStateFileQuery, WorkingStateQueryOptions, WorkingStateQueryResult } from "../harness/working-state/query-contract.js";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { canonicalizePathIdentity } from "../workspace/path-safety.js";
import type { KernelBranchReadResult, KernelBranchState, KernelEntry, KernelRecordResult, KernelWorkingDraftDocument } from "./protocol.generated.js";
import type { KernelClient, KernelGrantHandle, KernelScopedClient } from "./kernel-client.js";
import type { WorkspaceRecoveryEngine } from "../recovery/engine.js";
import type { RecoveryDurableOperationPort } from "../recovery/journal-engine.js";
import type { HostFileResourceBackend } from "../recovery/durable-file-operation.js";
import { type RecoveryFileStore, type RecoveryIdentity } from "../recovery/journal-files.js";
import type { MaterializeResult } from "../harness/working-state/materializer.js";
import { applyIndexModes } from "../harness/working-state/git-index-mode.js";
import { parseRecoveryState, sameState } from "../recovery/journal-files.js";
import type {
  DraftBaseline,
  DraftBaselinePathProvenance,
  ParentVerificationBundle,
  RecoveryState,
  ResultReviewRecord,
  ResultVerificationBundle,
  WorkingBranchRoot,
  WorkingResult,
  WorkingStatePin,
  WorkingStatePinnedRoot,
  WorkingStateContentSource,
  WorkingStateReadOptions,
  WorkingStateRootStore,
  WorkingStateTreeEntry,
  WorkingStateTreeRead,
  WorkspaceWorkingStateRootAccess,
} from "../harness/working-state/types.js";
import { assertVirtualWriteTree } from "../harness/working-state/virtual-write-tree.js";

type Mode = "exclusive" | "shared";

export interface KernelActorIdentity {
  authorityInstanceId?: string;
  workerId?: string;
  workerGeneration?: number;
  sessionId?: string;
  threadId?: string;
  runId?: string;
  owningWorkspace: string;
  executionWorkspace?: string;
  pathScopes?: string[];
  capabilities?: string[];
}

export interface KernelStorageReference {
  slot: string;
  objectHash: string;
}

export interface KernelPendingFileOperation {
  operationId: string;
  kind: string;
  rootId: string;
  paths: string[];
  disposition: "reconcile" | "needs-attention";
  reason: string;
  createdAt: number;
  updatedAt: number;
}

export interface KernelFileAuthorityContext {
  client: KernelScopedClient;
  rootId: string;
  owningWorkspaceId: string;
  executionWorkspaceId: string;
  canonicalRoot: string;
  pendingFileOperations: KernelPendingFileOperation[];
  reconcilePendingFileOperation(operationId: string): Promise<Record<string, unknown>>;
}

export interface KernelStorageContext {
  client: KernelScopedClient;
  actor?: KernelActorIdentity;
  identity: RecoveryIdentity;
  root: string;
  resolveMaterializationRoot(directory: string): Promise<KernelFileAuthorityContext & { basePath: string }>;
  resolveFileRoot(directory: string): Promise<{
    rootId: string;
    canonicalRoot: string;
    basePath: string;
    executionWorkspaceId: string;
  }>;
  fileStore: RecoveryFileStore;
  fileResources?: HostFileResourceBackend;
  resourceOperationGate: { run<T>(resources: readonly unknown[], operation: () => Promise<T>): Promise<T> };
  collectUnreachableObjects?: () => Promise<{ byteLengthReclaimed: number; objectsDeleted: number }>;
  durableRecoveryStore?: RecoveryDurableOperationPort;
  records: {
    get(recordId: string): Promise<KernelRecordResult | null>;
    list(input: { recordType?: string; threadId?: string; runId?: string; branchId?: string }): Promise<KernelRecordResult[]>;
    put(input: {
      operationId: string;
      recordId: string;
      recordType: string;
      state: string;
      payloadJson: string;
      references?: KernelStorageReference[];
      ownerIds?: string[];
      sessionId?: string;
      threadId?: string;
      runId?: string;
      branchId?: string;
      revision?: number;
      resultRevision?: number;
      expectedRecordRevision?: number;
    }): Promise<KernelRecordResult>;
    release(operationId: string, recordId: string): Promise<Record<string, unknown>>;
  };
  working: {
    resultPut(input: Omit<Parameters<KernelScopedClient["workingResultPut"]>[0], "workspaceId"> & { workspaceId?: string }): Promise<Record<string, unknown>>;
    resultGet(recordId: string): Promise<Record<string, unknown> | null>;
    resultList(branchId?: string): Promise<Record<string, unknown>[]>;
    resultRelease(operationId: string, recordId: string): Promise<Record<string, unknown>>;
    draftPut(input: Omit<Parameters<KernelScopedClient["workingDraftPut"]>[0], "workspaceId"> & { workspaceId?: string }): Promise<Record<string, unknown>>;
    draftGet(recordId: string): Promise<Record<string, unknown> | null>;
    draftList(): Promise<Record<string, unknown>[]>;
    draftRelease(operationId: string, recordId: string): Promise<Record<string, unknown>>;
    verificationPut(input: Omit<Parameters<KernelScopedClient["workingVerificationPut"]>[0], "workspaceId"> & { workspaceId?: string }): Promise<Record<string, unknown>>;
    verificationList(threadId: string, kind: "child" | "parent"): Promise<Record<string, unknown>[]>;
    verificationRelease(operationId: string, recordId: string): Promise<Record<string, unknown>>;
    reviewPut(input: Omit<Parameters<KernelScopedClient["workingReviewPut"]>[0], "workspaceId"> & { workspaceId?: string }): Promise<Record<string, unknown>>;
    reviewList(threadId: string): Promise<Record<string, unknown>[]>;
    reviewRelease(operationId: string, recordId: string): Promise<Record<string, unknown>>;
  };
}

const nowIso = (): string => new Date().toISOString();
const normalize = (value: string): string => {
  const raw = value.replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = raw.split("/").filter((part) => part && part !== ".");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || raw.includes("\0") || parts.includes("..")) {
    throw new Error(`Invalid working-state path: ${value}`);
  }
  return parts.join("/");
};

const normalizeViewPath = (value: string): string => {
  const raw = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!raw || raw === ".") return "";
  return normalize(raw);
};

const toKernelState = (state: RecoveryState): KernelBranchState => {
  if (state.kind === "regular-file") {
    return { kind: "regular-file", objectHash: state.objectHash, byteLength: state.byteLength, mode: state.mode ?? 0o644 };
  }
  if (state.kind === "directory") return { kind: "directory", ...(state.mode === undefined ? {} : { mode: state.mode }) };
  if (state.kind === "symlink") return { kind: "symlink", symlinkTarget: state.symlinkTarget, ...(state.mode === undefined ? {} : { mode: state.mode }) };
  return { kind: state.kind };
};

const fromKernelState = (state: KernelBranchState): RecoveryState => {
  if (state.kind === "regular-file") return { kind: "regular-file", objectHash: state.objectHash, byteLength: state.byteLength, mode: state.mode };
  if (state.kind === "directory") return { kind: "directory", ...(state.mode === undefined ? {} : { mode: state.mode }) };
  if (state.kind === "symlink") return { kind: "symlink", symlinkTarget: state.symlinkTarget, ...(state.mode === undefined ? {} : { mode: state.mode }) };
  return { kind: state.kind };
};

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const parsePendingFileOperation = (value: unknown): KernelPendingFileOperation => {
  const record = asRecord(value);
  const disposition = record.disposition;
  if (typeof record.operationId !== "string" || typeof record.kind !== "string" || typeof record.rootId !== "string"
    || !Array.isArray(record.paths) || !record.paths.every((path) => typeof path === "string")
    || (disposition !== "reconcile" && disposition !== "needs-attention")
    || typeof record.reason !== "string" || !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.updatedAt)) {
    throw new Error("Kernel returned an invalid pending file operation descriptor");
  }
  return {
    operationId: record.operationId, kind: record.kind, rootId: record.rootId, paths: [...record.paths] as string[],
    disposition, reason: record.reason, createdAt: Number(record.createdAt), updatedAt: Number(record.updatedAt),
  };
};

const checkRead = (options?: { signal?: AbortSignal; deadlineAt?: number }): void => {
  options?.signal?.throwIfAborted();
  if (options?.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
    throw new DOMException("Explore query deadline exceeded", "AbortError");
  }
};

const compactTreeWrites = (writes: Record<string, RecoveryState>): Record<string, RecoveryState> => {
  const entries = Object.entries(writes).sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries.filter(([path]) => {
    let parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    while (parent) {
      const ancestor = writes[parent];
      if (ancestor && ancestor.kind !== "directory") return false;
      parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : "";
    }
    return true;
  }));
};

const branchMissing = (error: unknown): boolean => /branch not found/i.test(error instanceof Error ? error.message : String(error));
const pinAlreadyReleasedWithGrant = (error: unknown): boolean => /grant is revoked|grant.*stale/i.test(error instanceof Error ? error.message : String(error));

interface KernelPinTreeRead {
  pinId: string;
  branchId: string;
  workspaceId: string;
  revision: number;
  writeRevision: number;
  view: "current" | "revision";
  root: string;
  entries: KernelEntry[];
  nextCursor?: number | null;
}

const parsePinTreeRead = (value: Record<string, unknown>): KernelPinTreeRead => {
  const view = value.view;
  const entries = Array.isArray(value.entries) ? value.entries.map((item) => {
    const entry = asRecord(item);
    if (typeof entry.path !== "string" || !entry.state || typeof entry.state !== "object" || Array.isArray(entry.state)) {
      throw new Error("Kernel returned an invalid pinned tree entry");
    }
    return { path: entry.path, state: entry.state as KernelBranchState };
  }) : [];
  if (typeof value.pinId !== "string" || typeof value.branchId !== "string" || typeof value.workspaceId !== "string"
    || typeof value.root !== "string" || (view !== "current" && view !== "revision")
    || !Number.isSafeInteger(value.revision) || !Number.isSafeInteger(value.writeRevision)) {
    throw new Error("Kernel returned an invalid pinned tree read");
  }
  return {
    pinId: value.pinId,
    branchId: value.branchId,
    workspaceId: value.workspaceId,
    revision: Number(value.revision),
    writeRevision: Number(value.writeRevision),
    view,
    root: value.root,
    entries,
    ...(value.nextCursor === undefined || value.nextCursor === null ? {} : { nextCursor: Number(value.nextCursor) }),
  };
};

/** Rust-kernel root/path authority. It retains no expanded branch or result tree. */
export class KernelWorkingStateRootStore implements WorkingStateRootStore {
  private readonly ownerByHash = new Map<string, string>();
  private readonly sourceByHash = new Map<string, { branchId?: string; pinId?: string; path?: string; revision?: number; recordId?: string; slot?: string; ownerId?: string }>();

  constructor(private readonly context: KernelStorageContext) {}

  private kernelFileRoot(directory: string): ReturnType<KernelStorageContext["resolveFileRoot"]> {
    return this.context.resolveFileRoot(directory);
  }

  private async kernelScanPaths(
    directory: string,
    scopes?: readonly string[],
    signal?: AbortSignal,
  ): Promise<string[]> {
    const root = await this.kernelFileRoot(directory);
    const output: string[] = [];
    // Enumerate once in the existing native compute lane. file.scan used to
    // rescan the entire directory on every page on the shared Storage thread,
    // blocking process I/O and unrelated workspaces for the duration of each walk.
    const prefix = root.basePath ? `${root.basePath}/` : "";
    const result = await runKernelCompute(this.context.client, {
      workspaceId: this.context.identity.workspaceId, rootId: root.rootId,
      lane: "foreground", operation: "inventory",
      paths: scopes?.length ? scopes.map(scope => `${prefix}${normalize(scope)}`) : [root.basePath],
    }, { signal, collect: false, onRecords: records => {
      for (const record of records) {
        if (record.kind !== "entry") continue;
        if (record.path === root.basePath) continue;
        if (prefix && !record.path.startsWith(prefix)) throw new Error("Kernel inventory escaped its admitted directory");
        output.push(normalize(record.path.slice(prefix.length)));
      }
    } });
    if (result.status !== "ready" && result.status !== "empty") throw new Error(result.message ?? "Workspace inventory did not complete");
    return [...new Set(output)].sort();
  }

  private async kernelMaterialize(
    sourceRoot: string,
    directory: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<MaterializeResult> {
    const root = await this.context.resolveMaterializationRoot(directory);
    const relativePath = root.basePath;
    if (!relativePath) {
      throw new Error(`Managed materialization target must be below its admitted root: ${directory}`);
    }
    const leaseId = `materialize-lease:${randomUUID()}`;
    for (;;) {
      signal?.throwIfAborted();
      const lease = await root.client.fileLeaseAcquire({
        workspaceId: this.context.identity.workspaceId,
        rootId: root.rootId,
        leaseId,
        resources: [{ path: relativePath, scope: "subtree" }],
      }, signal);
      if (lease.status === "acquired") break;
      if (lease.status !== "busy") throw new Error("Kernel returned an invalid materialization lease result");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    try {
      const result = await root.client.fileMaterialize({
        operationId,
        workspaceId: this.context.identity.workspaceId,
        rootId: root.rootId,
        path: relativePath,
        sourceRoot,
        leaseId,
      }, signal);
      if (result.status === "conflict") {
        throw new Error(`Managed materialization target conflicts with the requested immutable root: ${directory}`);
      }
      if (result.status !== "materialized") {
        throw new Error("Kernel returned an invalid WorkingState materialization result");
      }
      const cow = result.cow && typeof result.cow === "object" ? result.cow as Record<string, unknown> : {};
      return {
        targetDir: directory,
        materializedPaths: [],
        cleanedPaths: [],
        removedPaths: [],
        cow: {
          reflink: typeof cow.reflink === "number" ? cow.reflink : 0,
          copy: typeof cow.copy === "number" ? cow.copy : 0,
        },
      };
    } finally {
      await root.client.fileLeaseRelease({
        workspaceId: this.context.identity.workspaceId,
        rootId: root.rootId,
        leaseId,
      }).catch(() => undefined);
    }
  }

  private assertPinForBranch(branchId: string, pin: WorkingStatePinnedRoot): void {
    if (pin.branchId !== branchId || pin.workspaceId !== this.context.identity.workspaceId) {
      throw new Error(`Working-state pin ${pin.pinId} does not belong to ${this.context.identity.workspaceId}/${branchId}`);
    }
    if (pin.branch.branchId !== branchId || pin.branch.workspaceId !== pin.workspaceId) {
      throw new Error(`Working-state pin ${pin.pinId} has inconsistent branch provenance`);
    }
  }

  private assertPinRead(pin: WorkingStatePinnedRoot, read: KernelPinTreeRead | KernelBranchReadResult): asserts read is KernelPinTreeRead {
    this.assertPinForBranch(pin.branchId, pin);
    if (!("pinId" in read)) throw new Error(`Working-state pin ${pin.pinId} returned a live branch view`);
    const readIdentity = read.view === "current" ? read.writeRevision : read.revision;
    const pinIdentity = pin.view === "current" ? pin.writeRevision : pin.revision;
    if (read.pinId !== pin.pinId
      || read.branchId !== pin.branchId
      || read.workspaceId !== pin.workspaceId
      || read.view !== pin.view
      || read.revision !== pin.revision
      || readIdentity !== pinIdentity
      || read.root !== pin.root) {
      throw new Error(`Working-state pin ${pin.pinId} returned inconsistent provenance`);
    }
  }

  private async readRoot(branchId: string, revision: number | undefined, signal?: AbortSignal): Promise<KernelBranchReadResult | null> {
    try {
      return await this.context.client.readBranch({ branchId, ...(revision === undefined ? {} : { revision }) }, signal);
    } catch (error) {
      if (branchMissing(error)) return null;
      throw error;
    }
  }

  async getBranchRoot(branchId: string, options?: { signal?: AbortSignal }): Promise<WorkingBranchRoot | null> {
    const [current, base] = await Promise.all([
      this.readRoot(branchId, undefined, options?.signal),
      this.readRoot(branchId, 0, options?.signal),
    ]);
    if (!current || !base) return null;
    if (current.branchId !== branchId || base.branchId !== branchId
      || current.workspaceId !== this.context.identity.workspaceId || base.workspaceId !== current.workspaceId
      || current.view !== "current" || base.view !== "revision" || base.revision !== 0) {
      throw new Error(`Kernel returned inconsistent identity for working branch ${branchId}`);
    }
    const draftBasePaths = Array.isArray(current.draftBasePaths) && current.draftBasePaths.every((item) => typeof item === "string")
      ? current.draftBasePaths.map(normalize).sort()
      : null;
    const captureScopes = Array.isArray(current.captureScopes) && current.captureScopes.every((item) => typeof item === "string")
      ? current.captureScopes.map(normalize).sort()
      : null;
    const createdAt = Number(current.createdAt);
    const updatedAt = Number(current.updatedAt);
    if (!draftBasePaths || !captureScopes || !Number.isSafeInteger(createdAt) || createdAt < 0
      || !Number.isSafeInteger(updatedAt) || updatedAt < createdAt
      || base.parentRef !== current.parentRef
      || JSON.stringify(base.draftBasePaths) !== JSON.stringify(current.draftBasePaths)
      || JSON.stringify(base.captureScopes) !== JSON.stringify(current.captureScopes)
      || base.createdAt !== current.createdAt) {
      throw new Error(`Kernel returned invalid creation metadata for working branch ${branchId}`);
    }
    return {
      branchId,
      workspaceId: current.workspaceId,
      ...(current.parentRef ? { baseRef: current.parentRef } : {}),
      baseRoot: base.root,
      root: current.root,
      headRevision: current.headRevision,
      writeRevision: current.writeRevision,
      draftBasePaths,
      captureScopes,
      createdAt,
      updatedAt,
    };
  }

  async readStateSlice(branchId: string, paths: readonly string[], options?: WorkingStateReadOptions): Promise<Record<string, RecoveryState> | null> {
    checkRead(options);
    const normalizedPaths = paths.map(normalizeViewPath);
    if (options?.pin) this.assertPinForBranch(branchId, options.pin);
    const read = options?.pin
      ? await this.selectedPin(options.pin, normalizedPaths, options.signal)
      : await this.context.client.readBranch({
        branchId,
        ...(options?.revision === undefined ? {} : { revision: options.revision }),
        paths: normalizedPaths,
        includeEntries: true,
      }, options?.signal);
    if (options?.pin) this.assertPinRead(options.pin, read);
    else if (read.branchId !== branchId || read.workspaceId !== this.context.identity.workspaceId
      || (options?.revision === undefined
        ? read.view !== "current"
        : read.view !== "revision" || read.revision !== options.revision)) {
      throw new Error(`Working-state read returned inconsistent provenance for ${branchId}`);
    }
    const result: Record<string, RecoveryState> = {};
    for (const entry of read.entries) {
      checkRead(options);
      const path = normalize(entry.path);
      const state = fromKernelState(entry.state);
      result[path] = state;
      if (state.kind === "regular-file") {
        this.sourceByHash.set(state.objectHash, options?.pin
          ? { pinId: options.pin.pinId, path }
          : { branchId, path, ...(options?.revision === undefined ? {} : { revision: options.revision }) });
      }
    }
    return result;
  }

  async getResult(branchId: string, revision: number, options?: { signal?: AbortSignal }): Promise<WorkingResult | null> {
    const record = await this.context.working.resultGet(`working-result:${branchId}@${revision}`);
    if (!record) return null;
    const document = asRecord(record.record);
    if (document.branchId !== branchId || Number(document.resultRevision) !== revision || typeof document.root !== "string") return null;
    const changedPaths = Array.isArray(document.changedPaths) ? document.changedPaths.filter((value): value is string => typeof value === "string") : [];
    // Results published after baseline-rebase support carry their own frozen
    // base/path states, so a later baseline switch cannot rewrite the
    // provenance of an older revision. Documents predating that field fall
    // back to the live revision-0 base read.
    const storedStates = (key: "baseStates" | "pathStates"): Record<string, RecoveryState> | null => {
      const raw = asRecord(document[key]);
      const entries = Object.entries(raw ?? {});
      if (!entries.length) return null;
      try {
        return Object.fromEntries(entries.map(([file, state]) => [normalize(file), parseRecoveryState(state)]));
      } catch {
        return null;
      }
    };
    const storedBaseStates = storedStates("baseStates");
    const storedPathStates = storedStates("pathStates");
    const [base, fixed] = await Promise.all([
      storedBaseStates
        ? null
        : this.context.client.readBranch({ branchId, revision: 0, paths: changedPaths, includeEntries: true }, options?.signal),
      this.context.client.readBranch({ branchId, revision, paths: changedPaths, includeEntries: true }, options?.signal),
    ]);
    if (fixed.branchId !== branchId || fixed.workspaceId !== this.context.identity.workspaceId
      || fixed.view !== "revision" || fixed.revision !== revision
      || fixed.root !== document.root
      || (base !== null && (base.branchId !== branchId || base.workspaceId !== fixed.workspaceId
        || base.view !== "revision" || base.revision !== 0))) {
      throw new Error(`Working result ${branchId}@${revision} returned inconsistent provenance`);
    }
    const states = (page: KernelBranchReadResult): Record<string, RecoveryState> => {
      const byPath = new Map(page.entries.map((entry) => [normalize(entry.path), fromKernelState(entry.state)]));
      return Object.fromEntries(changedPaths.map((file) => [file, byPath.get(file) ?? { kind: "missing" as const }]));
    };
    const baseStates = storedBaseStates ?? states(base!);
    const resultRecordId = `working-result:${branchId}@${revision}`;
    for (const [file, state] of Object.entries(states(fixed))) if (state.kind === "regular-file") this.sourceByHash.set(state.objectHash, { recordId: resultRecordId, slot: `result:${file}`, branchId, path: file, revision });
    for (const [file, state] of Object.entries(baseStates)) if (state.kind === "regular-file") this.sourceByHash.set(state.objectHash, { recordId: resultRecordId, slot: `base:${file}`, branchId, path: file, revision: 0 });
    return {
      resultRevision: revision,
      branchId,
      ...(typeof document.parentRef === "string" ? { parentRef: document.parentRef } : {}),
      changedPaths,
      baseStates,
      pathStates: storedPathStates ?? states(fixed),
      diffStats: asRecord(document.diffStats) as unknown as WorkingResult["diffStats"],
      createdAt: typeof document.createdAt === "string" ? document.createdAt : nowIso(),
      root: document.root,
    };
  }

  async resultTreeIdentity(branchId: string, revision: number): Promise<string | null> {
    const result = await this.getResult(branchId, revision);
    return result?.root ?? null;
  }

  async listChildVerifications(threadId: string): Promise<ResultVerificationBundle[]> {
    return (await this.context.working.verificationList(threadId, "child")).map((entry) => asRecord(entry.record) as unknown as ResultVerificationBundle);
  }

  async listParentVerifications(threadId: string): Promise<ParentVerificationBundle[]> {
    return (await this.context.working.verificationList(threadId, "parent")).map((entry) => asRecord(entry.record) as unknown as ParentVerificationBundle);
  }

  async listReviewRecords(threadId: string): Promise<ResultReviewRecord[]> {
    return (await this.context.working.reviewList(threadId)).map((entry) => asRecord(entry.record) as unknown as ResultReviewRecord);
  }

  async getChildVerification(threadId: string, revision: number): Promise<ResultVerificationBundle | null> {
    return (await this.listChildVerifications(threadId)).find((entry) => entry.resultRevision === revision) ?? null;
  }

  async getParentVerification(threadId: string, revision?: number): Promise<ParentVerificationBundle | null> {
    const list = await this.listParentVerifications(threadId);
    return (revision === undefined ? list.at(-1) : list.find((entry) => entry.mergedResultRevision === revision)) ?? null;
  }

  async getReviewRecord(threadId: string, revision: number): Promise<ResultReviewRecord | null> {
    return (await this.listReviewRecords(threadId)).find((entry) => entry.resultRevision === revision) ?? null;
  }

  async putChildVerification(threadId: string, bundle: ResultVerificationBundle): Promise<void> {
    const result = await this.getResult(bundle.branchId, bundle.resultRevision);
    if (!result?.root) throw new Error(`Working result ${bundle.branchId}@${bundle.resultRevision} is unavailable`);
    await this.context.working.verificationPut({ operationId: `working-verification-child:${threadId}:${bundle.resultRevision}:${randomUUID()}`, recordId: `working-verification:child:${threadId}:${bundle.resultRevision}`, threadId, kind: "child", branchId: bundle.branchId, resultRevision: bundle.resultRevision, root: result.root, document: bundle, ownerIds: [], references: [] });
  }

  async putParentVerification(threadId: string, branchId: string, bundle: ParentVerificationBundle): Promise<void> {
    const result = await this.getResult(branchId, bundle.mergedResultRevision);
    if (!result?.root) throw new Error(`Working result ${branchId}@${bundle.mergedResultRevision} is unavailable`);
    await this.context.working.verificationPut({ operationId: `working-verification-parent:${threadId}:${bundle.mergedResultRevision}:${randomUUID()}`, recordId: `working-verification:parent:${threadId}:${bundle.mergedResultRevision}`, threadId, kind: "parent", branchId, resultRevision: bundle.mergedResultRevision, root: result.root, document: bundle, ownerIds: [], references: [] });
  }

  async putReviewRecord(threadId: string, branchId: string, record: ResultReviewRecord): Promise<void> {
    const result = await this.getResult(branchId, record.resultRevision);
    if (!result?.root) throw new Error(`Working result ${branchId}@${record.resultRevision} is unavailable`);
    await this.context.working.reviewPut({ operationId: `working-review:${threadId}:${record.resultRevision}:${randomUUID()}`, recordId: `working-review:${threadId}:${record.resultRevision}`, threadId, branchId, resultRevision: record.resultRevision, root: result.root, document: record, ownerIds: [], references: [] });
  }

  private async selected(branchId: string, paths: readonly string[], revision: number | undefined, signal?: AbortSignal): Promise<KernelBranchReadResult | null> {
    try {
      return await this.context.client.readBranch({
        branchId,
        ...(revision === undefined ? {} : { revision }),
        paths: [...paths],
      }, signal);
    } catch (error) {
      if (branchMissing(error)) return null;
      throw error;
    }
  }

  private async selectedPin(pin: WorkingStatePinnedRoot, paths: readonly string[], signal?: AbortSignal): Promise<KernelPinTreeRead> {
    this.assertPinForBranch(pin.branchId, pin);
    const read = parsePinTreeRead(await this.context.client.readPin({ pinId: pin.pinId, paths: [...paths] }, signal));
    this.assertPinRead(pin, read);
    return read;
  }

  private contentSource(branchId: string, path: string, revision: number | undefined, pin?: WorkingStateReadOptions["pin"]): WorkingStateContentSource {
    return pin
      ? { kind: "pin", pinId: pin.pinId, path }
      : { kind: "branch", branchId, path, ...(revision === undefined ? {} : { revision }) };
  }

  private origin(path: string, state: RecoveryState, base: RecoveryState, branch: WorkingBranchRoot): "base" | "delta" | "draft-base" {
    if (!sameState(state, base)) return "delta";
    return branch.draftBasePaths.includes(path) ? "draft-base" : "base";
  }

  async readPath(branchId: string, rawPath: string, options?: WorkingStateReadOptions): Promise<WorkingStateTreeEntry | null> {
    checkRead(options);
    const path = normalizeViewPath(rawPath);
    const revision = options?.revision;
    if (options?.pin) this.assertPinForBranch(branchId, options.pin);
    const branch = options?.pin?.branch ?? await this.getBranchRoot(branchId, options?.signal ? { signal: options.signal } : undefined);
    if (!branch) return null;
    const [current, base] = await Promise.all([
      options?.pin
        ? this.selectedPin(options.pin, path ? [path] : [], options.signal)
        : path ? this.selected(branchId, [path], revision, options?.signal) : this.readRoot(branchId, revision, options?.signal),
      path ? this.selected(branchId, [path], 0, options?.signal) : this.readRoot(branchId, 0, options?.signal),
    ]);
    if (!current) return null;
    if (options?.pin) this.assertPinRead(options.pin, current);
    const state = path ? fromKernelState(current.entries[0]?.state ?? { kind: "missing" }) : { kind: "directory" as const };
    const baseState = base
      ? path ? fromKernelState(base.entries[0]?.state ?? { kind: "missing" }) : { kind: "directory" as const }
      : state;
    const origin = this.origin(path, state, baseState, branch);
    return {
      path,
      state,
      origin,
      root: current.root,
      viewRevision: options?.pin?.writeRevision ?? options?.revision ?? current.writeRevision,
      ...(state.kind === "regular-file" ? { contentSource: this.contentSource(branchId, path, revision, options?.pin) } : {}),
    };
  }

  private async pagedEntries(
    branchId: string,
    revision: number | undefined,
    roots: readonly string[],
    options?: { signal?: AbortSignal; deadlineAt?: number },
  ): Promise<{ read: KernelBranchReadResult; entries: KernelEntry[] } | null> {
    const entries: KernelEntry[] = [];
    let cursor: number | undefined;
    let first: KernelBranchReadResult | undefined;
    do {
      checkRead(options);
      let page: KernelBranchReadResult;
      try {
        page = await this.context.client.readBranch({
          branchId,
          ...(revision === undefined ? {} : { revision }),
          roots: [...roots],
          includeEntries: true,
          ...(cursor === undefined ? {} : { cursor }),
          pageSize: 256,
        }, options?.signal);
      } catch (error) {
        if (branchMissing(error)) return null;
        throw error;
      }
      first ??= page;
      if (page.root !== first.root) throw new Error(`Working branch ${branchId} changed while listing paths`);
      for (const entry of page.entries) {
        const path = normalize(entry.path);
        if (roots.some((root) => !root || path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`))) {
          entries.push({ path, state: entry.state });
        }
      }
      cursor = page.nextCursor === null || page.nextCursor === undefined ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    return first ? { read: first, entries } : null;
  }

  private async pagedPinEntries(
    pin: WorkingStatePinnedRoot,
    roots: readonly string[],
    options?: { signal?: AbortSignal; deadlineAt?: number },
  ): Promise<{ read: KernelPinTreeRead; entries: KernelEntry[] }> {
    const entries: KernelEntry[] = [];
    let cursor: number | undefined;
    let first: KernelPinTreeRead | undefined;
    do {
      checkRead(options);
      const page = parsePinTreeRead(await this.context.client.readPin({
        pinId: pin.pinId,
        roots: [...roots],
        includeEntries: true,
        ...(cursor === undefined ? {} : { cursor }),
        pageSize: 256,
      }, options?.signal));
      this.assertPinRead(pin, page);
      first ??= page;
      if (page.root !== first.root) throw new Error(`Working-state pin ${pin.pinId} changed identity`);
      for (const entry of page.entries) {
        const path = normalize(entry.path);
        if (roots.some((root) => !root || path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`))) {
          entries.push({ path, state: entry.state });
        }
      }
      cursor = page.nextCursor === null || page.nextCursor === undefined ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    if (!first) throw new Error(`Working-state pin is unavailable: ${pin.pinId}`);
    return { read: first, entries };
  }

  async listPaths(branchId: string, rawRoots: readonly string[], options?: WorkingStateReadOptions): Promise<WorkingStateTreeRead | null> {
    const roots = (rawRoots.length ? rawRoots : [""]).map(normalizeViewPath);
    const revision = options?.revision;
    if (options?.pin) this.assertPinForBranch(branchId, options.pin);
    const branch = options?.pin?.branch ?? await this.getBranchRoot(branchId, options?.signal ? { signal: options.signal } : undefined);
    if (!branch) return null;
    const [current, base] = await Promise.all([
      options?.pin ? this.pagedPinEntries(options.pin, roots, options) : this.pagedEntries(branchId, revision, roots, options),
      this.pagedEntries(branchId, 0, roots, options),
    ]);
    if (!current) return null;
    if (options?.pin) this.assertPinRead(options.pin, current.read);
    const baseByPath = new Map((base?.entries ?? current.entries).map((entry) => [entry.path, fromKernelState(entry.state)]));
    return {
      branch,
      root: current.read.root,
      viewRevision: options?.pin?.writeRevision ?? options?.revision ?? current.read.writeRevision,
      entries: current.entries.map((entry) => {
        const state = fromKernelState(entry.state);
        const origin = this.origin(entry.path, state, baseByPath.get(entry.path) ?? { kind: "missing" }, branch);
        return {
          path: entry.path,
          state,
          origin,
          ...(state.kind === "regular-file" ? { contentSource: this.contentSource(branchId, entry.path, revision, options?.pin) } : {}),
        };
      }),
    };
  }

  async readContent(entry: WorkingStateTreeEntry, options?: { offset?: number; length?: number; signal?: AbortSignal }): Promise<Buffer | null> {
    if (entry.state.kind !== "regular-file" || !entry.contentSource) return null;
    const source = entry.contentSource.kind === "pin"
      ? { pinId: entry.contentSource.pinId, path: entry.contentSource.path }
      : { branchId: entry.contentSource.branchId, path: entry.contentSource.path, ...(entry.contentSource.revision === undefined ? {} : { revision: entry.contentSource.revision }) };
    try {
      const slice = await this.context.client.getBlob(entry.state.objectHash, source, {
        ...(options?.offset === undefined ? {} : { offset: options.offset }),
        ...(options?.length === undefined ? {} : { length: options.length }),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      return Buffer.from(slice.bytesBase64, "base64");
    } catch (error) {
      if ((error as { code?: string }).code === "object-not-found") return null;
      throw error;
    }
  }

  async getObject(hash: string): Promise<Buffer | null> {
    const ownerId = this.ownerByHash.get(hash);
    const source = this.sourceByHash.get(hash);
    if (!ownerId && !source?.pinId && !source?.branchId && !source?.recordId) return null;
    const slice = await this.context.client.getBlob(hash, ownerId
      ? { ownerId }
      : source?.pinId
        ? { pinId: source.pinId, path: source.path! }
      : source?.recordId
        ? { recordId: source.recordId, slot: source.slot ?? "" }
        : { branchId: source!.branchId!, path: source!.path!, ...(source!.revision === undefined ? {} : { revision: source!.revision }) });
    return Buffer.from(slice.bytesBase64, "base64");
  }

  async getObjectSlice(hash: string, _byteLength: number, offset: number, length: number): Promise<Buffer | null> {
    const ownerId = this.ownerByHash.get(hash);
    const source = this.sourceByHash.get(hash);
    if (!ownerId && !source?.pinId && !source?.branchId && !source?.recordId) return null;
    const slice = await this.context.client.getBlob(hash, ownerId
      ? { ownerId }
      : source?.pinId
        ? { pinId: source.pinId, path: source.path! }
      : source?.recordId
        ? { recordId: source.recordId, slot: source.slot ?? "" }
        : { branchId: source!.branchId!, path: source!.path!, ...(source!.revision === undefined ? {} : { revision: source!.revision }) }, { offset, length });
    return Buffer.from(slice.bytesBase64, "base64");
  }

  ownerIdForObject(hash: string): string | undefined { return this.ownerByHash.get(hash); }

  async queryFiles(pin: WorkingStatePinnedRoot, request: WorkingStateFileQuery, options?: WorkingStateQueryOptions): Promise<WorkingStateQueryResult> {
    if (pin.workspaceId !== this.context.identity.workspaceId) throw new Error("Query pin belongs to another workspace");
    const result = await runKernelCompute(this.context.client, { ...request, workspaceId: pin.workspaceId, pinId: pin.pinId }, options);
    if (result.root !== pin.root) throw new Error("Query result changed its fixed source root");
    return result;
  }

  async pinBranch(branchId: string, options?: { revision?: number; signal?: AbortSignal }): Promise<WorkingStatePin> {
    const branch = await this.getBranchRoot(branchId, options?.signal ? { signal: options.signal } : undefined);
    if (!branch) throw new Error(`Working branch not found: ${branchId}`);
    const expected = options?.revision === undefined ? branch : null;
    const operationId = `branch-query-pin:${branchId}:${randomUUID()}`;
    const raw = await this.context.client.pinBranch({
      operationId,
      branchId,
      ...(options?.revision === undefined
        ? { expectedWriteRevision: expected!.writeRevision, expectedRoot: expected!.root }
        : { revision: options.revision }),
    }, options?.signal);
    if (raw.status === "conflict") {
      throw new Error(`Working branch changed while pinning ${branchId}; current write revision is ${String(raw.writeRevision)}`);
    }
    const pinId = String(raw.pinId ?? "");
    const pinnedBranchId = String(raw.branchId ?? "");
    const workspaceId = String(raw.workspaceId ?? "");
    const revision = Number(raw.revision);
    const view = raw.view;
    const rawWriteRevision = Number(raw.writeRevision);
    const writeRevision = view === "current" ? rawWriteRevision : revision;
    const root = String(raw.root ?? "");
    if (!pinId || pinnedBranchId !== branchId || workspaceId !== this.context.identity.workspaceId
      || !Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(writeRevision)
      || writeRevision < 0 || (view !== "current" && view !== "revision") || !root) {
      throw new Error(`Kernel returned an invalid pin for ${branchId}`);
    }
    if (expected && (root !== expected.root || writeRevision !== expected.writeRevision || view !== "current")) {
      await this.context.client.unpinBranch({ operationId: `branch-query-unpin-mismatch:${branchId}:${pinId}`, branchId, pinId });
      throw new Error(`Kernel cannot pin unpublished working root ${branchId}@${expected.writeRevision}`);
    }
    let releasePromise: Promise<void> | undefined;
    return {
      pinId,
      branchId,
      workspaceId,
      view,
      revision,
      writeRevision,
      root,
      branch,
      release: async () => {
        releasePromise ??= this.context.client
          .unpinBranch({ operationId: `branch-query-unpin:${branchId}:${pinId}`, branchId, pinId })
          .catch((error) => {
            if (!pinAlreadyReleasedWithGrant(error)) throw error;
          })
          .then(() => undefined);
        await releasePromise;
      },
    };
  }

  private pinResult(raw: Record<string, unknown>, branch: WorkingBranchRoot, expectedPinId?: string): WorkingStatePin {
    const pinId = String(raw.pinId ?? "");
    const branchId = String(raw.branchId ?? "");
    const workspaceId = String(raw.workspaceId ?? "");
    const revision = Number(raw.revision);
    const view = raw.view;
    const rawWriteRevision = Number(raw.writeRevision);
    const writeRevision = view === "current" ? rawWriteRevision : revision;
    const root = String(raw.root ?? "");
    if (!pinId || (expectedPinId !== undefined && pinId !== expectedPinId) || branchId !== branch.branchId
      || workspaceId !== this.context.identity.workspaceId || !Number.isSafeInteger(revision) || revision < 0
      || !Number.isSafeInteger(writeRevision) || writeRevision < 0 || (view !== "current" && view !== "revision") || !root) {
      throw new Error(`Kernel returned an invalid pin for ${branch.branchId}`);
    }
    let releasePromise: Promise<void> | undefined;
    return {
      pinId, branchId, workspaceId, view, revision, writeRevision, root, branch,
      release: async () => {
        releasePromise ??= this.context.client
          .unpinBranch({ operationId: `branch-handoff-unpin:${branchId}:${pinId}`, branchId, pinId })
          .catch((error) => { if (!pinAlreadyReleasedWithGrant(error)) throw error; })
          .then(() => undefined);
        await releasePromise;
      },
    };
  }

  async pinBranchHandoff(branchId: string, pinId: string, options?: { revision?: number; signal?: AbortSignal }): Promise<WorkingStatePin> {
    const branch = await this.getBranchRoot(branchId, options?.signal ? { signal: options.signal } : undefined);
    if (!branch) throw new Error(`Working branch not found: ${branchId}`);
    const raw = await this.context.client.pinBranch({
      operationId: `branch-handoff-pin:${branchId}:${pinId}`,
      branchId,
      pinId,
      ...(options?.revision === undefined
        ? { expectedWriteRevision: branch.writeRevision, expectedRoot: branch.root, persistent: true }
        : { revision: options.revision }),
    }, options?.signal);
    if (raw.status === "conflict") throw new Error(`Working branch changed while fixing materialization handoff ${branchId}`);
    return this.pinResult(raw, branch, pinId);
  }

  async openBranchHandoffPin(
    branchId: string,
    pinId: string,
    expected: { root: string; revision: number; writeRevision: number },
    signal?: AbortSignal,
  ): Promise<WorkingStatePin> {
    const branch = await this.getBranchRoot(branchId, signal ? { signal } : undefined);
    if (!branch) throw new Error(`Working branch not found while reopening materialization handoff: ${branchId}`);
    const raw = await this.context.client.readPin({ pinId, includeEntries: false }, signal);
    const pin = this.pinResult(raw, branch, pinId);
    if (pin.root !== expected.root || pin.revision !== expected.revision || pin.writeRevision !== expected.writeRevision) {
      throw new Error(`Materialization handoff pin identity changed: ${branchId}/${pinId}`);
    }
    return pin;
  }

  async releaseBranchHandoffPin(branchId: string, pinId: string): Promise<void> {
    await this.context.client.unpinBranch({
      operationId: `branch-handoff-unpin:${branchId}:${pinId}`,
      branchId,
      pinId,
    }).catch((error) => {
      if (!/pin not found/i.test(error instanceof Error ? error.message : String(error)) && !pinAlreadyReleasedWithGrant(error)) throw error;
    });
  }

  async putObject(bytes: Buffer): Promise<{ hash: string; byteLength: number }> {
    const value = await this.context.client.putBlob(bytes, `blob:${randomUUID()}`);
    const existingOwner = this.ownerByHash.get(value.hash);
    if (existingOwner) {
      await this.context.client.releaseBlob(value.ownerId);
      return { hash: value.hash, byteLength: value.byteLength };
    }
    this.ownerByHash.set(value.hash, value.ownerId);
    return { hash: value.hash, byteLength: value.byteLength };
  }

  private kernelEntry(file: string, state: RecoveryState): { path: string; state: KernelBranchState; ownerId?: string; sourcePath?: string; sourceRecordId?: string; sourceSlot?: string } {
    const source = state.kind === "regular-file" ? this.sourceByHash.get(state.objectHash) : undefined;
    return {
      path: normalize(file),
      state: toKernelState(state),
      ...(state.kind === "regular-file" && this.ownerByHash.has(state.objectHash)
        ? { ownerId: this.ownerByHash.get(state.objectHash)! }
        : state.kind === "regular-file" && source?.recordId && source.slot
          ? { sourceRecordId: source.recordId, sourceSlot: source.slot }
          : state.kind === "regular-file" && source?.path
            ? { sourcePath: source.path }
            : {}),
    };
  }

  async createBranch(workspaceId: string, branchId: string, baseState: Record<string, RecoveryState>, baseRef?: string, draftBasePaths: string[] = [], captureScopes: string[] = []): Promise<WorkingBranchRoot> {
    if (workspaceId !== this.context.identity.workspaceId) throw new Error("Working-state workspace mismatch");
    const kernelBaseRef = baseRef && (/^sha256-[a-f0-9]+$/i.test(baseRef) || baseRef.startsWith("pin:") || /^.+@\d+$/.test(baseRef)) ? baseRef : undefined;
    const normalizedDraftPaths = [...new Set(draftBasePaths.map(normalize))].sort();
    const normalizedCaptureScopes = [...new Set(captureScopes.map(normalize))].sort();
    const entries = Object.entries(baseState).map(([file, state]) => this.kernelEntry(file, state));
    const pendingOwners = new Map(Object.values(baseState).flatMap((state) => {
      if (state.kind !== "regular-file") return [];
      const ownerId = this.ownerByHash.get(state.objectHash);
      return ownerId ? [[state.objectHash, ownerId] as const] : [];
    }));
    const forgetPendingOwners = (): void => {
      for (const [hash, ownerId] of pendingOwners) if (this.ownerByHash.get(hash) === ownerId) this.ownerByHash.delete(hash);
    };
    const releasePendingOwners = async (bestEffort = false): Promise<void> => {
      const releases = [...new Set(pendingOwners.values())].map((ownerId) => this.context.client.releaseBlob(ownerId));
      if (bestEffort) await Promise.allSettled(releases);
      else await Promise.all(releases);
      forgetPendingOwners();
    };
    let created: Record<string, unknown>;
    try {
      created = await this.context.client.createBranch({
        operationId: `branch-create:${branchId}`,
        branchId,
        workspaceId,
        entries,
        ...(kernelBaseRef ? { baseRef: kernelBaseRef } : {}),
        ...(baseRef ? { parentRef: baseRef } : {}),
        draftBasePaths: normalizedDraftPaths,
        captureScopes: normalizedCaptureScopes,
      });
    } catch (error) {
      await releasePendingOwners(true);
      throw error;
    }
    if (created.created === true) forgetPendingOwners();
    else await releasePendingOwners();
    try {
      for (const [file, state] of Object.entries(baseState)) if (state.kind === "regular-file") {
        this.sourceByHash.set(state.objectHash, { branchId, path: normalize(file), revision: 0 });
      }
      const branch = await this.getBranchRoot(branchId);
      if (!branch) throw new Error(`Working branch not found after creation: ${branchId}`);
      if (branch.baseRef !== baseRef
        || JSON.stringify(branch.draftBasePaths) !== JSON.stringify(normalizedDraftPaths)
        || JSON.stringify(branch.captureScopes) !== JSON.stringify(normalizedCaptureScopes)
        || String(created.root ?? "") !== branch.root) {
        throw new Error(`Working branch has different creation identity: ${branchId}`);
      }
      return branch;
    } catch (error) {
      if (created.created === true) {
        await this.context.client.deleteBranch({ operationId: `branch-delete-failed-create:${branchId}:${randomUUID()}`, branchId }).catch(() => undefined);
      }
      throw error;
    }
  }

  async createBranchFromPin(workspaceId: string, branchId: string, pin: WorkingStatePin, parentRef: string, draftBaselineId?: string | null, captureScopes: string[] = []): Promise<WorkingBranchRoot> {
    if (pin.workspaceId !== workspaceId) throw new Error("Parent working-state pin belongs to another workspace");
    this.assertPinForBranch(pin.branchId, pin);
    const draft = draftBaselineId ? await this.getDraftBaseline(draftBaselineId) : null;
    if (draftBaselineId && !draft) throw new Error(`Thread draft baseline not found: ${draftBaselineId}`);
    const directDraftPaths = draft ? Object.keys(draft.pathStates).map(normalize) : [];
    const parentEntries = directDraftPaths.length > 0 ? await this.listPaths(pin.branchId, directDraftPaths, { pin }) : null;
    const draftClosure = new Set(directDraftPaths);
    for (const file of directDraftPaths) {
      let parent = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
      while (parent) { draftClosure.add(parent); parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : ""; }
    }
    for (const entry of parentEntries?.entries ?? []) if (directDraftPaths.some((file) => entry.path.startsWith(`${file}/`))) draftClosure.add(entry.path);
    const normalizedDraftPaths = [...draftClosure].sort();
    const normalizedCaptureScopes = [...new Set(captureScopes.map(normalize))].sort();
    const created = await this.context.client.createBranch({
      operationId: `branch-create:${branchId}`,
      branchId,
      workspaceId,
      entries: [],
      baseRef: pin.root,
      parentRef,
      draftBasePaths: normalizedDraftPaths,
      captureScopes: normalizedCaptureScopes,
    });
    try {
      if (created.created === true && draft && directDraftPaths.length > 0) {
        const committed = await this.commitVirtualWrites(branchId, Number(created.writeRevision ?? 0), draft.pathStates);
        if (committed.status !== "committed") throw new Error(`Working branch changed while restoring draft baseline: ${branchId}`);
      }
      const branch = await this.getBranchRoot(branchId);
      if (!branch) throw new Error(`Working branch not found after creation: ${branchId}`);
      if (branch.baseRoot !== pin.root || branch.baseRef !== parentRef
        || JSON.stringify(branch.draftBasePaths) !== JSON.stringify(normalizedDraftPaths)
        || JSON.stringify(branch.captureScopes) !== JSON.stringify(normalizedCaptureScopes)) {
        throw new Error(`Working branch has different creation identity: ${branchId}`);
      }
      if (draft) {
        const current = await this.readStateSlice(branchId, directDraftPaths);
        if (!current || directDraftPaths.some((file) => !sameState(current[file] ?? { kind: "missing" }, draft.pathStates[file] ?? { kind: "missing" }))) {
          throw new Error(`Existing working branch does not contain its draft baseline: ${branchId}`);
        }
      }
      return branch;
    } catch (error) {
      if (created.created === true) {
        await this.context.client.deleteBranch({ operationId: `branch-delete-failed-create:${branchId}:${randomUUID()}`, branchId }).catch(() => undefined);
      }
      throw error;
    }
  }

  async createDraftBaseline(workspaceId: string, paths: readonly { path: string; content: string | Buffer; mode?: number; provenance: DraftBaselinePathProvenance }[]): Promise<DraftBaseline> {
    if (workspaceId !== this.context.identity.workspaceId) throw new Error("Working-state workspace mismatch");
    const id = `draft-${randomUUID()}`;
    const branchId = `working-draft:${id}`;
    const pathStates: Record<string, RecoveryState> = {};
    const provenance: Record<string, DraftBaselinePathProvenance> = {};
    const ownerIds: string[] = [];
    const references: KernelStorageReference[] = [];
    for (const input of paths) {
      const file = normalize(input.path);
      const object = await this.putObject(typeof input.content === "string" ? Buffer.from(input.content, "utf8") : input.content);
      pathStates[file] = { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength, ...(input.mode === undefined ? {} : { mode: input.mode }) };
      provenance[file] = structuredClone(input.provenance);
      const owner = this.ownerByHash.get(object.hash);
      if (owner) ownerIds.push(owner);
      references.push({ slot: `draft:${file}`, objectHash: object.hash });
    }
    const baseline: DraftBaseline = { id, workspaceId, createdAt: nowIso(), pathStates, provenance };
    let branchCreated = false;
    try {
      const created = await this.context.client.createBranch({
        operationId: `draft-branch-create:${id}`,
        branchId,
        workspaceId,
        entries: Object.entries(pathStates).map(([file, state]) => this.kernelEntry(file, state)),
        draftBasePaths: [],
        captureScopes: [],
      });
      branchCreated = created.created === true;
      for (const state of Object.values(pathStates)) if (state.kind === "regular-file") this.ownerByHash.delete(state.objectHash);
      const published = await this.context.client.publishBranch({
        operationId: `draft-branch-publish:${id}`,
        branchId,
        expectedWriteRevision: Number(created.writeRevision ?? 0),
        expectedRoot: String(created.root ?? ""),
      });
      if (published.status === "conflict") throw new Error(`Draft branch changed while publishing: ${id}`);
      const revision = Number(published.revision);
      const root = String(published.root ?? "");
      if (!Number.isSafeInteger(revision) || revision < 1 || !root) throw new Error(`Kernel returned an invalid draft identity: ${id}`);
      const document: KernelWorkingDraftDocument = {
        id,
        workspaceId,
        branchId,
        revision,
        createdAt: baseline.createdAt,
        root,
        provenance: Object.entries(provenance).map(([file, value]) => ({ path: file, ...value })),
      };
      await this.context.working.draftPut({ operationId: `draft:${id}`, recordId: id, branchId, revision, document, root, createdAt: baseline.createdAt, ownerIds: [], references });
      for (const [file, state] of Object.entries(pathStates)) if (state.kind === "regular-file") {
        this.sourceByHash.set(state.objectHash, { recordId: id, slot: `draft:${file}`, branchId, path: file, revision });
      }
    } catch (error) {
      if (branchCreated) await this.context.client.deleteBranch({ operationId: `draft-branch-delete-failed:${id}`, branchId }).catch(() => undefined);
      for (const ownerId of ownerIds) await this.context.client.releaseBlob(ownerId).catch(() => undefined);
      throw error;
    }
    return structuredClone(baseline);
  }

  async getDraftBaseline(id: string): Promise<DraftBaseline | null> {
    const raw = await this.context.working.draftGet(id);
    if (!raw) return null;
    const document = asRecord(raw.record);
    if (document.id !== id || document.workspaceId !== this.context.identity.workspaceId || typeof document.branchId !== "string"
      || !Number.isSafeInteger(document.revision) || typeof document.root !== "string" || !Array.isArray(document.provenance)) return null;
    const provenance: Record<string, DraftBaselinePathProvenance> = {};
    for (const item of document.provenance) {
      const value = asRecord(item);
      if (typeof value.path !== "string" || typeof value.encoding !== "string" || typeof value.bom !== "boolean"
        || !Number.isSafeInteger(value.localEditRevision) || typeof value.revision !== "string"
        || (value.baseRevision !== null && typeof value.baseRevision !== "string")) throw new Error(`Draft baseline provenance is malformed: ${id}`);
      provenance[normalize(value.path)] = {
        baseRevision: value.baseRevision as string | null,
        encoding: value.encoding,
        bom: value.bom,
        localEditRevision: Number(value.localEditRevision),
        revision: value.revision,
      };
    }
    const files = Object.keys(provenance).sort();
    const fixed = await this.context.client.readBranch({ branchId: document.branchId, revision: Number(document.revision), paths: files, includeEntries: true });
    if (fixed.branchId !== document.branchId || fixed.workspaceId !== this.context.identity.workspaceId
      || fixed.view !== "revision" || fixed.revision !== Number(document.revision) || fixed.root !== document.root) {
      throw new Error(`Draft baseline fixed revision has inconsistent provenance: ${id}`);
    }
    const byPath = new Map(fixed.entries.map((entry) => [normalize(entry.path), fromKernelState(entry.state)]));
    const pathStates: Record<string, RecoveryState> = {};
    for (const file of files) {
      const state = byPath.get(file);
      if (!state || state.kind !== "regular-file") throw new Error(`Draft baseline content is unavailable for ${file}`);
      pathStates[file] = state;
      this.sourceByHash.set(state.objectHash, { recordId: id, slot: `draft:${file}`, branchId: document.branchId, path: file, revision: Number(document.revision) });
    }
    return { id, workspaceId: this.context.identity.workspaceId, createdAt: typeof document.createdAt === "string" ? document.createdAt : nowIso(), pathStates, provenance };
  }

  async deleteDraftBaseline(id: string): Promise<void> {
    await this.context.working.draftRelease(`draft-release:${id}`, id);
  }

  async commitVirtualWrites(branchId: string, expectedWriteRevision: number, files: Record<string, RecoveryState>): Promise<{ status: "committed"; writeRevision: number; root?: string } | { status: "conflict"; writeRevision: number; root?: string }> {
    const normalized = Object.fromEntries(Object.entries(files).map(([file, state]) => [normalize(file), state]));
    const releaseInputOwners = async (): Promise<void> => {
      const owned = new Map(Object.values(normalized).flatMap((state) => {
        if (state.kind !== "regular-file") return [];
        const ownerId = this.ownerByHash.get(state.objectHash);
        return ownerId ? [[state.objectHash, ownerId] as const] : [];
      }));
      await Promise.all([...new Set(owned.values())].map((ownerId) => this.context.client.releaseBlob(ownerId)));
      for (const [hash, ownerId] of owned) if (this.ownerByHash.get(hash) === ownerId) this.ownerByHash.delete(hash);
    };
    const ancestorPaths = new Set<string>();
    for (const file of Object.keys(normalized)) {
      let parent = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
      while (parent) {
        ancestorPaths.add(parent);
        parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : "";
      }
    }
    const selectedPaths = [...new Set([...Object.keys(normalized), ...ancestorPaths])];
    const [currentRead, baseRead] = await Promise.all([
      this.selected(branchId, selectedPaths, undefined),
      this.selected(branchId, selectedPaths, 0),
    ]);
    if (!currentRead || !baseRead) throw new Error(`Working branch not found: ${branchId}`);
    if (currentRead.writeRevision !== expectedWriteRevision) {
      await releaseInputOwners();
      return { status: "conflict", writeRevision: currentRead.writeRevision, root: currentRead.root };
    }
    const current = Object.fromEntries(currentRead.entries.map((entry) => [normalize(entry.path), fromKernelState(entry.state)]));
    const base = Object.fromEntries(baseRead.entries.map((entry) => [normalize(entry.path), fromKernelState(entry.state)]));
    assertVirtualWriteTree(current, normalized);
    const closed = { ...normalized };
    for (const [file, state] of Object.entries(normalized)) {
      if (state.kind === "missing") continue;
      let parent = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
      while (parent) {
        if (!closed[parent] && !current[parent]) {
          const baseParent = base[parent];
          closed[parent] = baseParent?.kind === "directory" ? baseParent : { kind: "directory" };
        }
        parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : "";
      }
    }
    const committedWrites = compactTreeWrites(closed);
    const retainedHashes = new Set(Object.values(committedWrites).flatMap((state) => (
      state.kind === "regular-file" ? [state.objectHash] : []
    )));
    for (const state of Object.values(normalized)) {
      if (state.kind !== "regular-file" || retainedHashes.has(state.objectHash)) continue;
      const ownerId = this.ownerByHash.get(state.objectHash);
      if (!ownerId) continue;
      await this.context.client.releaseBlob(ownerId);
      this.ownerByHash.delete(state.objectHash);
    }
    const changes = Object.entries(committedWrites).map(([path, state]) => ({
      path,
      state: toKernelState(state),
      ...(state.kind === "regular-file" && this.ownerByHash.has(state.objectHash)
        ? { ownerId: this.ownerByHash.get(state.objectHash)! }
        : state.kind === "regular-file" && this.sourceByHash.get(state.objectHash)?.recordId && this.sourceByHash.get(state.objectHash)?.slot
          ? { sourceRecordId: this.sourceByHash.get(state.objectHash)!.recordId!, sourceSlot: this.sourceByHash.get(state.objectHash)!.slot! }
          : state.kind === "regular-file" && this.sourceByHash.get(state.objectHash)?.branchId && this.sourceByHash.get(state.objectHash)?.path
            ? { sourcePath: this.sourceByHash.get(state.objectHash)!.path! }
            : {}),
    }));
    const result = await this.context.client.writeBranch({ operationId: `branch-write:${branchId}:${expectedWriteRevision + 1}:${randomUUID()}`, branchId, expectedWriteRevision, changes });
    if (result.status === "committed") {
      for (const state of Object.values(committedWrites)) if (state.kind === "regular-file") this.ownerByHash.delete(state.objectHash);
    } else await releaseInputOwners();
    return { status: result.status, writeRevision: result.writeRevision, root: result.root };
  }

  async rebaseBranch(
    branchId: string,
    expectedWriteRevision: number,
    rebase: {
      baseRef: string;
      parentRef?: string;
      changes: Record<string, RecoveryState>;
    },
  ): Promise<{ status: "committed"; writeRevision: number; root?: string } | { status: "conflict"; writeRevision: number; root?: string }> {
    const normalized = Object.fromEntries(Object.entries(rebase.changes).map(([file, state]) => [normalize(file), state]));
    const releaseInputOwners = async (): Promise<void> => {
      const owned = new Map(Object.values(normalized).flatMap((state) => {
        if (state.kind !== "regular-file") return [];
        const ownerId = this.ownerByHash.get(state.objectHash);
        return ownerId ? [[state.objectHash, ownerId] as const] : [];
      }));
      await Promise.all([...new Set(owned.values())].map((ownerId) => this.context.client.releaseBlob(ownerId)));
      for (const [hash, ownerId] of owned) if (this.ownerByHash.get(hash) === ownerId) this.ownerByHash.delete(hash);
    };
    const currentRead = await this.selected(branchId, [], undefined);
    if (!currentRead) {
      await releaseInputOwners();
      throw new Error(`Working branch not found: ${branchId}`);
    }
    if (currentRead.writeRevision !== expectedWriteRevision) {
      await releaseInputOwners();
      return { status: "conflict", writeRevision: currentRead.writeRevision, root: currentRead.root };
    }
    const committedWrites = compactTreeWrites(normalized);
    const changes = Object.entries(committedWrites).map(([path, state]) => ({
      path,
      state: toKernelState(state),
      ...(state.kind === "regular-file" && this.ownerByHash.has(state.objectHash)
        ? { ownerId: this.ownerByHash.get(state.objectHash)! }
        : state.kind === "regular-file" && this.sourceByHash.get(state.objectHash)?.recordId && this.sourceByHash.get(state.objectHash)?.slot
          ? { sourceRecordId: this.sourceByHash.get(state.objectHash)!.recordId!, sourceSlot: this.sourceByHash.get(state.objectHash)!.slot! }
          : state.kind === "regular-file" && this.sourceByHash.get(state.objectHash)?.branchId && this.sourceByHash.get(state.objectHash)?.path
            ? { sourcePath: this.sourceByHash.get(state.objectHash)!.path! }
            : {}),
    }));
    const result = await this.context.client.writeBranch({
      operationId: `branch-rebase:${branchId}:${expectedWriteRevision + 1}:${randomUUID()}`,
      branchId,
      expectedWriteRevision,
      changes,
      baseRef: rebase.baseRef,
      ...(rebase.parentRef === undefined ? {} : { parentRef: rebase.parentRef }),
    });
    if (result.status === "committed") {
      for (const state of Object.values(committedWrites)) if (state.kind === "regular-file") this.ownerByHash.delete(state.objectHash);
    } else await releaseInputOwners();
    return { status: result.status, writeRevision: result.writeRevision, root: result.root };
  }

  async materializeResult(branchId: string, revision: number, directory: string): Promise<MaterializeResult> {
    const read = await this.context.client.readBranch({ branchId, revision, includeEntries: false });
    if (typeof read.root !== "string" || read.root.length === 0) {
      throw new Error(`Working result not found: ${branchId}@${revision}`);
    }
    return this.kernelMaterialize(read.root, directory, `working-materialize:${randomUUID()}`);
  }

  async materializePin(pin: WorkingStatePin, directory: string): Promise<MaterializeResult> {
    this.assertPinForBranch(pin.branchId, pin);
    return this.kernelMaterialize(pin.root, directory, `working-materialize:${randomUUID()}`);
  }

  async materializePinManaged(
    pin: WorkingStatePin,
    directory: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<MaterializeResult> {
    this.assertPinForBranch(pin.branchId, pin);
    return this.kernelMaterialize(pin.root, directory, operationId, signal);
  }

  async captureDirectory(directory: string, relativePaths?: string[], options?: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; store?: boolean; indexModes?: Map<string, string> | Record<string, string> }): Promise<Record<string, RecoveryState>> {
    const files = relativePaths?.map(normalize) ?? await this.kernelScanPaths(directory, undefined, options?.signal);
    const root = await this.kernelFileRoot(directory);
    const result: Record<string, RecoveryState> = {};
    let done = 0;
    for (const file of files) {
      options?.signal?.throwIfAborted();
      const targetPath = root.basePath ? `${root.basePath}/${file}` : file;
      const leaseId = `capture-lease:${randomUUID()}`;
      for (;;) {
        options?.signal?.throwIfAborted();
        // Keep the acquisition receipt across cancellation; the capture's
        // finally block must release any lease the kernel actually granted.
        const lease = await this.context.client.fileLeaseAcquire({
          workspaceId: this.context.identity.workspaceId, rootId: root.rootId, leaseId,
          resources: [{ path: targetPath, scope: "exact" }],
        });
        if (lease.status === "acquired") break;
        if (lease.status !== "busy") throw new Error("Kernel returned an invalid capture lease result");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const value = await this.context.client.fileCapture({
        operationId: `working-capture:${randomUUID()}`,
        workspaceId: this.context.identity.workspaceId,
        rootId: root.rootId,
        path: targetPath,
        leaseId,
        store: options?.store !== false,
      }, options?.signal).finally(() => this.context.client.fileLeaseRelease({
        workspaceId: this.context.identity.workspaceId, rootId: root.rootId, leaseId,
      }));
      if (typeof value.stateJson !== "string") {
        throw new Error(`Kernel returned an invalid baseline state for ${file}`);
      }
      const state = parseRecoveryState(JSON.parse(value.stateJson));
      if (state.kind === "regular-file" && options?.store !== false && typeof value.ownerId === "string") {
        const existingOwner = this.ownerByHash.get(state.objectHash);
        if (existingOwner && existingOwner !== value.ownerId) {
          await this.context.client.releaseBlob(value.ownerId);
        } else {
          this.ownerByHash.set(state.objectHash, value.ownerId);
        }
      }
      result[file] = state;
      done += 1;
      options?.onProgress?.(done, files.length);
    }
    return applyIndexModes(result, options?.indexModes);
  }

  async listCaptureScopePaths(directory: string, scopes: readonly string[], signal?: AbortSignal): Promise<string[]> {
    return this.kernelScanPaths(directory, scopes, signal);
  }

  async listWorkspaceBaselinePaths(directory: string, signal?: AbortSignal): Promise<string[]> {
    return this.kernelScanPaths(directory, undefined, signal);
  }

  private async publishCaptured(branchId: string, captured: Record<string, RecoveryState>, changedPaths?: string[], fixedPin?: WorkingStatePin): Promise<WorkingResult> {
    const branch = await this.getBranchRoot(branchId);
    if (!branch) throw new Error(`Working branch not found: ${branchId}`);
    const currentDiff = changedPaths
      ? null
      : asRecord(await this.context.client.diffRoots({ leftRoot: branch.baseRoot, rightRoot: fixedPin?.root ?? branch.root }));
    const candidates = [...new Set([
      ...(changedPaths?.map(normalize) ?? Object.keys(captured).map(normalize)),
      ...(currentDiff
        ? [
            ...(Array.isArray(currentDiff.added) ? currentDiff.added : []),
            ...(Array.isArray(currentDiff.removed) ? currentDiff.removed : []),
            ...(Array.isArray(currentDiff.changed) ? currentDiff.changed : []),
          ].filter((value): value is string => typeof value === "string").map(normalize)
        : []),
    ])].sort();
    const base = await this.context.client.readBranch({ branchId, revision: 0, paths: candidates, includeEntries: true });
    const current = fixedPin ? undefined : await this.context.client.readBranch({ branchId, paths: candidates, includeEntries: true });
    const states = (page: KernelBranchReadResult): Record<string, RecoveryState> => Object.fromEntries(page.entries.map((entry) => [normalize(entry.path), fromKernelState(entry.state)]));
    const baseStates = states(base);
    const currentStates = current ? states(current) : {};
    const writes = fixedPin ? {} : Object.fromEntries(candidates.filter((file) => !sameState(currentStates[file] ?? { kind: "missing" }, captured[file] ?? { kind: "missing" })).map((file) => [file, captured[file] ?? { kind: "missing" as const}]));
    const requiredOwnerHashes = new Set(Object.entries(writes).flatMap(([file, state]) => (
      state.kind === "regular-file" && !sameState(state, baseStates[file] ?? { kind: "missing" }) ? [state.objectHash] : []
    )));
    for (const [file, state] of Object.entries(captured)) {
      if (state.kind !== "regular-file" || requiredOwnerHashes.has(state.objectHash)) continue;
      const ownerId = this.ownerByHash.get(state.objectHash);
      if (ownerId) {
        await this.context.client.releaseBlob(ownerId);
        this.ownerByHash.delete(state.objectHash);
      }
      if (sameState(state, baseStates[file] ?? { kind: "missing" })) {
        this.sourceByHash.set(state.objectHash, { branchId, path: file, revision: 0 });
      }
    }
    let fixedRoot = fixedPin?.root ?? current!.root;
    let fixedWriteRevision = fixedPin?.writeRevision ?? current!.writeRevision;
    if (Object.keys(writes).length > 0) {
      const committed = await this.commitVirtualWrites(branchId, branch.writeRevision, writes);
      if (committed.status === "conflict") throw new Error(`Working branch changed while publishing result: ${branchId}`);
      if (!committed.root) throw new Error(`Kernel did not return the published working root for ${branchId}`);
      fixedRoot = committed.root;
      fixedWriteRevision = committed.writeRevision;
    }
    const pin = fixedPin ?? await this.pinBranch(branchId);
    try {
      if (pin.root !== fixedRoot || pin.writeRevision !== fixedWriteRevision) {
        throw new Error(`Working branch changed while pinning result ${branchId}`);
      }
      const rootDiff = asRecord(await this.context.client.diffRoots({ leftRoot: branch.baseRoot, rightRoot: pin.root }));
      const changed = [
        ...(Array.isArray(rootDiff.added) ? rootDiff.added : []),
        ...(Array.isArray(rootDiff.removed) ? rootDiff.removed : []),
        ...(Array.isArray(rootDiff.changed) ? rootDiff.changed : []),
      ].filter((value): value is string => typeof value === "string").map(normalize).sort();
      const fixed = await this.selectedPin(pin, changed);
      const pathStates = Object.fromEntries(fixed.entries.map((entry) => [normalize(entry.path), fromKernelState(entry.state)]));
      const resultBase = Object.fromEntries(changed.map((file) => [file, baseStates[file] ?? { kind: "missing" as const }]));
      const published = await this.context.client.publishBranch({ operationId: `branch-publish:${branchId}:${branch.headRevision + 1}`, branchId, expectedWriteRevision: pin.writeRevision, expectedRoot: pin.root });
      if (published.status === "conflict") throw new Error(`Working branch changed while publishing result: ${branchId}`);
      const revision = Number(published.revision);
      const root = String(published.root ?? "");
      if (!Number.isSafeInteger(revision) || revision <= 0 || !root || root !== pin.root) throw new Error("Kernel returned an invalid published result identity");
      const result: WorkingResult = { resultRevision: revision, branchId, changedPaths: changed, baseStates: resultBase, pathStates, diffStats: { files: changed.length, insertions: 0, deletions: 0 }, createdAt: nowIso(), root };
      const references = [
        ...Object.entries(result.baseStates).flatMap(([file, state]) => state.kind === "regular-file" ? [{ slot: `base:${file}`, objectHash: state.objectHash }] : []),
        ...Object.entries(result.pathStates).flatMap(([file, state]) => state.kind === "regular-file" ? [{ slot: `result:${file}`, objectHash: state.objectHash }] : []),
      ];
      const resultRecordId = `working-result:${branchId}@${revision}`;
      await this.context.working.resultPut({ operationId: `result:${branchId}:${revision}`, recordId: resultRecordId, branchId, resultRevision: revision, root, changedPaths: changed, diffStats: result.diffStats, createdAt: result.createdAt, document: { resultRevision: revision, branchId, changedPaths: changed, diffStats: result.diffStats, createdAt: result.createdAt, root, baseRoot: branch.baseRoot, baseStates: result.baseStates, pathStates: result.pathStates }, ownerIds: [], references });
      // Publishing consumes transient blob owners. Keep immediate readers on
      // the immutable result record rather than on the branch head, which may
      // already have advanced concurrently.
      for (const [file, state] of Object.entries(result.baseStates)) if (state.kind === "regular-file") {
        this.sourceByHash.set(state.objectHash, { recordId: resultRecordId, slot: `base:${file}`, branchId, path: file, revision: 0 });
      }
      for (const [file, state] of Object.entries(result.pathStates)) if (state.kind === "regular-file") {
        this.sourceByHash.set(state.objectHash, { recordId: resultRecordId, slot: `result:${file}`, branchId, path: file, revision });
      }
      return result;
    } finally {
      if (!fixedPin) await pin.release();
    }
  }

  async publishHeadResult(branchId: string): Promise<WorkingResult> {
    const branch = await this.getBranchRoot(branchId);
    if (!branch) throw new Error(`Working branch not found: ${branchId}`);
    const pin = await this.pinBranch(branchId);
    try {
      if (pin.root !== branch.root || pin.writeRevision !== branch.writeRevision) throw new Error(`Working branch changed while pinning result ${branchId}`);
      const diff = asRecord(await this.context.client.diffRoots({ leftRoot: branch.baseRoot, rightRoot: pin.root }));
      const changedPaths = [
        ...(Array.isArray(diff.added) ? diff.added : []),
        ...(Array.isArray(diff.removed) ? diff.removed : []),
        ...(Array.isArray(diff.changed) ? diff.changed : []),
      ].filter((value): value is string => typeof value === "string").map(normalize);
      const read = await this.selectedPin(pin, changedPaths);
      return await this.publishCaptured(branchId, Object.fromEntries(read.entries.map((entry) => [normalize(entry.path), fromKernelState(entry.state)])), changedPaths, pin);
    } finally {
      await pin.release();
    }
  }

  async publishDirectoryResult(branchId: string, directory: string, changedPaths?: string[], options?: { indexModes?: Map<string, string> | Record<string, string>; validateFixedSource?: () => Promise<boolean> }): Promise<WorkingResult> {
    const ownersBefore = new Map(this.ownerByHash);
    const normalizedPaths = changedPaths?.map(normalize);
    const captured = await this.captureDirectory(directory, normalizedPaths, options);
    const releaseNewOwners = async (): Promise<void> => {
      const releases: Promise<unknown>[] = [];
      for (const state of Object.values(captured)) {
        if (state.kind !== "regular-file") continue;
        const ownerId = this.ownerByHash.get(state.objectHash);
        if (!ownerId || ownersBefore.get(state.objectHash) === ownerId) continue;
        this.ownerByHash.delete(state.objectHash);
        releases.push(this.context.client.releaseBlob(ownerId));
      }
      await Promise.allSettled(releases);
    };
    try {
      const initialPaths = (normalizedPaths ?? Object.keys(captured)).sort();
      const observedPaths = normalizedPaths ?? await this.kernelScanPaths(directory);
      if (initialPaths.length !== observedPaths.length
        || initialPaths.some((file, index) => file !== observedPaths[index])) {
        throw new Error("Working-state directory inventory changed while it was being captured");
      }
      const observed = await this.captureDirectory(directory, observedPaths, {
        ...options,
        store: false,
      });
      const changed = observedPaths.filter((file) => !sameState(
        captured[file] ?? { kind: "missing" },
        observed[file] ?? { kind: "missing" },
      ));
      if (changed.length > 0) {
        throw new Error(`Working-state directory changed while it was being captured: ${changed.slice(0, 8).join(",")}`);
      }
      if (options?.validateFixedSource && !await options.validateFixedSource()) {
        throw new Error("Working-state source changed while it was being captured");
      }
      return await this.publishCaptured(branchId, captured, normalizedPaths);
    } catch (error) {
      await releaseNewOwners();
      throw error;
    }
  }

  async captureBranchCandidateIdentity(branchId: string, directory: string, changedPaths: string[]): Promise<string | null> {
    const branch = await this.getBranchRoot(branchId);
    if (!branch) return null;
    const hash = createHash("sha256");
    for (const file of [...new Set(changedPaths.map(normalize))].sort()) {
      const captured = await this.context.fileStore.captureState({ ...this.context.identity, canonicalRoot: directory }, this.context.root, file, { store: false });
      hash.update(file).update("\0").update(JSON.stringify(captured.state)).update("\0");
    }
    hash.update(branch.root);
    return `sha256-${hash.digest("hex")}`;
  }

  async captureSeededPathIdentity(directory: string, changedPaths: string[], seed: string): Promise<string> {
    const hash = createHash("sha256").update(seed).update("\0");
    for (const file of [...new Set(changedPaths.map(normalize))].sort()) {
      const captured = await this.context.fileStore.captureState({ ...this.context.identity, canonicalRoot: directory }, this.context.root, file, { store: false });
      hash.update(file).update("\0").update(JSON.stringify(captured.state)).update("\0");
    }
    return `sha256-${hash.digest("hex")}`;
  }

  async listResults(branchId?: string): Promise<WorkingResult[]> {
    const rows = await this.context.working.resultList(branchId);
    const results: WorkingResult[] = [];
    for (const row of rows) {
      const document = asRecord(row.record);
      if (typeof document.branchId !== "string" || !Number.isSafeInteger(document.resultRevision)) continue;
      const result = await this.getResult(document.branchId, Number(document.resultRevision));
      if (result) results.push(result);
    }
    return results.sort((left, right) => left.resultRevision - right.resultRevision);
  }

  async deleteResults(branchId: string, revisions: readonly number[]): Promise<number[]> {
    const removed: number[] = [];
    for (const revision of [...new Set(revisions)]) {
      const recordId = `working-result:${branchId}@${revision}`;
      if (!await this.context.working.resultGet(recordId)) continue;
      await this.context.working.resultRelease(`result-release:${branchId}@${revision}`, recordId);
      removed.push(revision);
    }
    return removed;
  }

  async deleteBranch(branchId: string): Promise<void> {
    if (!await this.getBranchRoot(branchId)) return;
    await this.context.client.deleteBranch({ operationId: `branch-delete:${branchId}`, branchId });
  }

  async collectUnreachableObjects(): Promise<{ byteLengthReclaimed: number; objectsDeleted: number }> {
    if (!this.context.collectUnreachableObjects) throw new Error("Object cleanup is unavailable");
    return this.context.collectUnreachableObjects();
  }

  async listDurableOperations(kind?: string): Promise<Record<string, unknown>[]> {
    if (!this.context.durableRecoveryStore) throw new Error("Durable recovery operation storage is unavailable");
    return this.context.durableRecoveryStore.listOperations(this.context.identity.workspaceId, kind);
  }

  async listBranchObjectReferences(branchId: string): Promise<Array<{ hash: string; byteLength: number | null }>> {
    const objects: Array<{ hash: string; byteLength: number | null }> = [];
    let cursor: number | undefined;
    do {
      const page = asRecord(await this.context.client.branchObjects({ branchId, includeRevisions: true, ...(cursor === undefined ? {} : { cursor }), pageSize: 256 }));
      if (page.branchId !== branchId) throw new Error(`Kernel returned object references for another branch: ${branchId}`);
      for (const raw of Array.isArray(page.objects) ? page.objects : []) {
        const object = asRecord(raw);
        if (typeof object.hash !== "string" || !Number.isSafeInteger(object.byteLength) || Number(object.byteLength) < 0) {
          throw new Error(`Kernel returned an invalid object reference for ${branchId}`);
        }
        objects.push({ hash: object.hash, byteLength: Number(object.byteLength) });
      }
      cursor = page.nextCursor === null || page.nextCursor === undefined ? undefined : Number(page.nextCursor);
    } while (cursor !== undefined);
    return objects;
  }

  async listDraftObjectReferences(id: string): Promise<Array<{ hash: string; byteLength: number | null }>> {
    const raw = await this.context.working.draftGet(id);
    if (!raw) return [];
    const document = asRecord(raw.record);
    if (typeof document.branchId !== "string") throw new Error(`Draft baseline branch identity is malformed: ${id}`);
    return this.listBranchObjectReferences(document.branchId);
  }

  async measurePin(pin: WorkingStatePin): Promise<import("@varin/protocol").ThreadSpaceMeasurement> {
    this.assertPinForBranch(pin.branchId, pin);
    let logical = 0;
    let unknown = false;
    let cursor: number | undefined;
    do {
      const page = parsePinTreeRead(await this.context.client.readPin({ pinId: pin.pinId, roots: [""], includeEntries: true, ...(cursor === undefined ? {} : { cursor }), pageSize: 256 }));
      this.assertPinRead(pin, page);
      for (const entry of page.entries) {
        const state = fromKernelState(entry.state);
        if (state.kind === "regular-file") logical += state.byteLength;
        else if (state.kind === "symlink") logical += Buffer.byteLength(state.symlinkTarget, "utf8");
        else if (state.kind === "unsupported") unknown = true;
      }
      cursor = page.nextCursor === null || page.nextCursor === undefined ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    return { logicalBytes: unknown ? null : logical, allocatedBytes: null, unknown };
  }

  async directoryMatchesResult(branchId: string, revision: number, directory: string): Promise<boolean> {
    const expectedRead = await this.listPaths(branchId, [""], { revision });
    if (!expectedRead) return false;
    const actual = await this.captureDirectory(directory, undefined, { store: false });
    const expected = Object.fromEntries(expectedRead.entries.map((entry) => [entry.path, entry.state]));
    const paths = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    const observable = (state: RecoveryState): RecoveryState => {
      if (process.platform !== "win32" || (state.kind !== "regular-file" && state.kind !== "directory") || state.mode === undefined) return state;
      return { ...state, mode: (state.mode & 0o200) === 0 ? 0o444 : 0o666 };
    };
    return [...paths].every((file) => sameState(
      observable(actual[file] ?? { kind: "missing" }), observable(expected[file] ?? { kind: "missing" }),
    ));
  }
}

export interface KernelStorageAdapterOptions {
  client: KernelClient;
  hostId: string;
  hostGeneration?: string;
  resolveWorkspaceRoot: (workspaceId: string) => Promise<string>;
  fileStore?: RecoveryFileStore;
  storageRoot: string;
  resolveActor?: (workspaceId: string, purpose: string, hint?: KernelActorIdentity) => KernelActorIdentity | Promise<KernelActorIdentity>;
  durableRecoveryStore?: RecoveryDurableOperationPort;
}

export type KernelFileRootResolver = (
  canonicalRoot: string,
  owningWorkspaceId: string,
) => Promise<{ workspaceId: string; canonicalRoot: string }>;

export class KernelStorageAdapter {
  readonly client: KernelClient;
  private readonly options: KernelStorageAdapterOptions;
  private readonly grants = new Map<string, Promise<KernelGrantHandle>>();
  private boundFileStore: RecoveryFileStore | undefined;
  private boundFileResources: HostFileResourceBackend | undefined;
  private fileRootResolver: KernelFileRootResolver | undefined;
  private managedRootResolver: KernelFileRootResolver | undefined;
  private readonly fileStoreProxy: RecoveryFileStore;
  constructor(options: KernelStorageAdapterOptions) {
    this.options = options;
    this.client = options.client;
    this.boundFileStore = options.fileStore;
    this.fileStoreProxy = {
      applyState: (...args) => this.boundFileStore?.applyState(...args) ?? Promise.reject(new Error("Kernel recovery file store is not bound")),
      captureState: (...args) => this.boundFileStore?.captureState(...args) ?? Promise.reject(new Error("Kernel recovery file store is not bound")),
      hashFile: (...args) => this.boundFileStore?.hashFile(...args) ?? Promise.reject(new Error("Kernel recovery file store is not bound")),
      relativePathFor: (...args) => this.boundFileStore?.relativePathFor(...args) ?? Promise.reject(new Error("Kernel recovery file store is not bound")),
      verifyObject: (...args) => this.boundFileStore?.verifyObject(...args) ?? Promise.reject(new Error("Kernel recovery file store is not bound")),
    };
  }

  bindFileStore(fileStore: RecoveryFileStore): void {
    if (this.boundFileStore && this.boundFileStore !== fileStore) {
      throw new Error("Kernel recovery file store is already bound");
    }
    this.boundFileStore = fileStore;
  }

  bindFileResources(fileResources: HostFileResourceBackend): void {
    if (this.boundFileResources && this.boundFileResources !== fileResources) {
      throw new Error("Kernel file-resource backend is already bound");
    }
    this.boundFileResources = fileResources;
  }

  bindFileRootResolver(resolver: KernelFileRootResolver): void {
    if (this.fileRootResolver && this.fileRootResolver !== resolver) {
      throw new Error("Kernel file-root resolver is already bound");
    }
    this.fileRootResolver = resolver;
  }

  bindManagedRootResolver(resolver: KernelFileRootResolver): void {
    if (this.managedRootResolver && this.managedRootResolver !== resolver) {
      throw new Error("Kernel managed-root resolver is already bound");
    }
    this.managedRootResolver = resolver;
  }

  async fileAuthorityContext(input: {
    owningWorkspaceId: string;
    executionWorkspaceId: string;
    canonicalRoot: string;
    purpose?: string;
    capabilities?: string[];
    actor?: KernelActorIdentity;
  }): Promise<KernelFileAuthorityContext> {
    const grant = await this.grantFor(input.owningWorkspaceId, input.purpose ?? "file-resource", input.actor ?? {
      owningWorkspace: input.owningWorkspaceId,
      executionWorkspace: input.executionWorkspaceId,
      pathScopes: [""],
      capabilities: input.capabilities ?? ["storage.maintenance"],
    });
    const client = this.client.scoped(grant);
    const registered = await client.fileRootRegister({
      workspaceId: input.owningWorkspaceId,
      executionWorkspaceId: input.executionWorkspaceId,
      canonicalRoot: input.canonicalRoot,
    });
    if (typeof registered.rootId !== "string" || typeof registered.canonicalRoot !== "string") {
      throw new Error("Kernel returned an invalid file root registration");
    }
    const rootId = registered.rootId;
    const pendingFileOperations: KernelPendingFileOperation[] = [];
    if (Number(registered.pendingOperations ?? 0) > 0) {
      let cursor: number | undefined;
      do {
        const page = await client.fileOperationList({
          workspaceId: input.owningWorkspaceId, rootId, ...(cursor === undefined ? {} : { cursor }), pageSize: 128,
        });
        if (!Array.isArray(page.operations)) throw new Error("Kernel returned an invalid pending file operation page");
        pendingFileOperations.push(...page.operations.map(parsePendingFileOperation));
        cursor = typeof page.nextCursor === "number" ? page.nextCursor : undefined;
      } while (cursor !== undefined);
    }
    return {
      client, rootId,
      owningWorkspaceId: input.owningWorkspaceId,
      executionWorkspaceId: input.executionWorkspaceId,
      canonicalRoot: registered.canonicalRoot,
      pendingFileOperations,
      reconcilePendingFileOperation: (operationId: string) => client.fileOperationReconcile({
        workspaceId: input.owningWorkspaceId, rootId, operationId,
      }),
    };
  }

  private async grantFor(workspaceId: string, purpose: string, actorOverride?: KernelActorIdentity): Promise<KernelGrantHandle> {
    const actor = this.options.resolveActor
      ? await this.options.resolveActor(workspaceId, purpose, actorOverride)
      : actorOverride ?? { owningWorkspace: workspaceId, executionWorkspace: workspaceId, pathScopes: [""] };
    const capabilities = [...new Set(["storage.read", "storage.write", "recovery", ...(actor.capabilities ?? []), ...(purpose === "recovery-maintenance" ? ["recovery.maintenance", "storage.gc"] : purpose.includes("gc") ? ["storage.gc"] : [])])].sort();
    // Object insertion order is not actor identity. Recovery capture and record
    // writers construct the same named fields in different orders; hashing those
    // raw objects minted different grants and invalidated transferred owners.
    const actorJson = JSON.stringify(Object.fromEntries(Object.entries(actor)
      .filter(([, value]) => value !== undefined).sort(([left], [right]) => left.localeCompare(right))));
    const key = JSON.stringify({ workspaceId, actorJson, capabilities });
    const existing = this.grants.get(key); if (existing) return existing;
    const grant = (async () => {
      const actorKey = createHash("sha256").update(actorJson).digest("hex").slice(0, 24);
      const capabilityKey = createHash("sha256").update(JSON.stringify(capabilities)).digest("hex").slice(0, 12);
      return this.client.issueGrant({ grantId: `product:${this.options.hostId}:${this.options.hostGeneration ?? process.pid}:${workspaceId}:${actorKey}:${capabilityKey}`, ...actor, capabilities, pathScopes: actor.pathScopes ?? [""] });
    })();
    this.grants.set(key, grant); return grant;
  }
  async context(workspaceId: string, purpose: string, actorOverride?: KernelActorIdentity): Promise<KernelStorageContext & { client: KernelScopedClient }> {
    const root = this.options.storageRoot;
    const identity: RecoveryIdentity = { authorityId: this.options.hostId, canonicalRoot: await this.options.resolveWorkspaceRoot(workspaceId), filesystemProfile: process.platform === "win32" ? "windows-local" : `${process.platform}-local`, workspaceId };
    const grant = await this.grantFor(workspaceId, purpose, actorOverride);
    const scoped = this.client.scoped(grant);
    const records = {
      get: (recordId: string) => scoped.getRecord(workspaceId, recordId),
      list: async (input: { recordType?: string; threadId?: string; runId?: string; branchId?: string }) => { const all: KernelRecordResult[] = []; let cursor: number | undefined; do { const page = await scoped.listRecords({ workspaceId, ...input, ...(cursor === undefined ? {} : { cursor }), pageSize: 128 }); all.push(...page.records); cursor = page.nextCursor === null ? undefined : page.nextCursor; } while (cursor !== undefined); return all; },
      put: (input: Omit<Parameters<KernelScopedClient["putRecord"]>[0], "ownerIds" | "references"> & { ownerIds?: string[]; references?: KernelStorageReference[] }) => scoped.putRecord({ ...input, workspaceId, ownerIds: input.ownerIds ?? [], references: input.references ?? [] }),
      release: (operationId: string, recordId: string) => scoped.releaseRecord(operationId, workspaceId, recordId),
    };
    const working = {
      resultPut: (input: Omit<Parameters<KernelScopedClient["workingResultPut"]>[0], "workspaceId"> & { workspaceId?: string }) => scoped.workingResultPut({ ...input, workspaceId }),
      resultGet: async (recordId: string) => scoped.workingResultGet({ workspaceId, recordId }),
      resultList: async (branchId?: string) => {
        const result = await scoped.workingResultList({ workspaceId, ...(branchId === undefined ? {} : { branchId }) });
        return Array.isArray(result.records) ? result.records as Record<string, unknown>[] : [];
      },
      resultRelease: (operationId: string, recordId: string) => scoped.workingResultRelease({ operationId, workspaceId, recordId }),
      draftPut: (input: Omit<Parameters<KernelScopedClient["workingDraftPut"]>[0], "workspaceId"> & { workspaceId?: string }) => scoped.workingDraftPut({ ...input, workspaceId }),
      draftGet: async (recordId: string) => scoped.workingDraftGet({ workspaceId, recordId }),
      draftList: async () => {
        const result = await scoped.workingDraftList({ workspaceId });
        return Array.isArray(result.records) ? result.records as Record<string, unknown>[] : [];
      },
      draftRelease: (operationId: string, recordId: string) => scoped.workingDraftRelease({ operationId, workspaceId, recordId }),
      verificationPut: (input: Omit<Parameters<KernelScopedClient["workingVerificationPut"]>[0], "workspaceId"> & { workspaceId?: string }) => scoped.workingVerificationPut({ ...input, workspaceId }),
      verificationList: async (threadId: string, kind: "child" | "parent") => {
        const result = await scoped.workingVerificationList({ workspaceId, threadId, kind });
        return Array.isArray(result.records) ? result.records as Record<string, unknown>[] : [];
      },
      verificationRelease: (operationId: string, recordId: string) => scoped.workingVerificationRelease({ operationId, workspaceId, recordId }),
      reviewPut: (input: Omit<Parameters<KernelScopedClient["workingReviewPut"]>[0], "workspaceId"> & { workspaceId?: string }) => scoped.workingReviewPut({ ...input, workspaceId }),
      reviewList: async (threadId: string) => {
        const result = await scoped.workingReviewList({ workspaceId, threadId });
        return Array.isArray(result.records) ? result.records as Record<string, unknown>[] : [];
      },
      reviewRelease: (operationId: string, recordId: string) => scoped.workingReviewRelease({ operationId, workspaceId, recordId }),
    };
    const resolveMaterializationRoot = async (directory: string) => {
      if (!this.managedRootResolver || !grant.capabilities.some((capability) => capability === "storage.maintenance" || capability === "storage.admin")) {
        throw new Error("Kernel managed materialization requires explicit Host ownership admission");
      }
      const resolved = await this.managedRootResolver(path.resolve(directory), workspaceId);
      const [canonicalRoot, canonicalTarget] = await Promise.all([
        canonicalizePathIdentity(resolved.canonicalRoot),
        canonicalizePathIdentity(directory, { allowMissing: true }),
      ]);
      const basePath = path.relative(canonicalRoot, canonicalTarget).replace(/\\/g, "/");
      if (!basePath || basePath === ".." || basePath.startsWith("../") || path.isAbsolute(basePath)) {
        throw new Error(`Managed materialization target is not below its ownership root: ${directory}`);
      }
      const authority = await this.fileAuthorityContext({
        owningWorkspaceId: workspaceId, executionWorkspaceId: resolved.workspaceId,
        canonicalRoot, purpose: "working-managed-materialization",
        capabilities: ["storage.maintenance"],
      });
      return { ...authority, basePath };
    };
    const resolveFileRoot = async (directory: string) => {
      // Windows runners can expose the same directory through an 8.3 alias
      // while Documents returns its long canonical path. Compare and register
      // one real identity so an alias cannot be rejected as an unrelated root.
      const requestedRoot = await canonicalizePathIdentity(directory);
      const resolved = this.fileRootResolver
        ? await this.fileRootResolver(requestedRoot, workspaceId)
        : {
            workspaceId: grant.executionWorkspace ?? workspaceId,
            canonicalRoot: await this.options.resolveWorkspaceRoot(workspaceId),
          };
      const canonicalRoot = await canonicalizePathIdentity(resolved.canonicalRoot);
      const relative = path.relative(canonicalRoot, requestedRoot);
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
        throw new Error(`WorkingState file root was not admitted by the Host: ${directory}`);
      }
      const executionWorkspaceId = grant.executionWorkspace ?? workspaceId;
      if (resolved.workspaceId !== executionWorkspaceId) {
        throw new Error(`WorkingState execution workspace mismatch: expected ${executionWorkspaceId}, got ${resolved.workspaceId}`);
      }
      const registered = await scoped.fileRootRegister({
        workspaceId,
        executionWorkspaceId,
        canonicalRoot,
      });
      if (typeof registered.rootId !== "string" || typeof registered.canonicalRoot !== "string") {
        throw new Error("Kernel returned an invalid WorkingState file root registration");
      }
      return {
        rootId: registered.rootId,
        canonicalRoot: registered.canonicalRoot,
        basePath: relative ? relative.replace(/\\/g, "/") : "",
        executionWorkspaceId,
      };
    };
    return {
      identity,
      root,
      resolveFileRoot,
      resolveMaterializationRoot,
      actor: {
        ...(grant.sessionId ? { sessionId: grant.sessionId } : {}),
        ...(grant.authorityInstanceId ? { authorityInstanceId: grant.authorityInstanceId } : {}),
        ...(grant.workerId ? { workerId: grant.workerId } : {}),
        ...(grant.workerGeneration === null ? {} : { workerGeneration: grant.workerGeneration }),
        ...(grant.threadId ? { threadId: grant.threadId } : {}),
        ...(grant.runId ? { runId: grant.runId } : {}),
        owningWorkspace: grant.owningWorkspace ?? workspaceId,
        ...(grant.executionWorkspace ? { executionWorkspace: grant.executionWorkspace } : {}),
        pathScopes: [...grant.pathScopes],
        capabilities: [...grant.capabilities],
      },
      fileStore: this.fileStoreProxy,
      ...(this.boundFileResources ? { fileResources: this.boundFileResources } : {}),
      resourceOperationGate: {
        run: async () => { throw new Error("Kernel resource operation gate is not bound"); },
      },
      collectUnreachableObjects: async () => {
        const maintenance = await this.context(workspaceId, "recovery-maintenance", { owningWorkspace: workspaceId, executionWorkspace: workspaceId, pathScopes: [""], capabilities: ["recovery.maintenance", "storage.gc"] });
        const result = await maintenance.client.gc(`kernel-gc:${workspaceId}:${randomUUID()}`);
        if (Array.isArray(result.cleanupFailures) && result.cleanupFailures.length > 0) {
          throw new Error(`Kernel object cleanup failed: ${result.cleanupFailures.join('; ')}`);
        }
        if (typeof result.byteLengthReclaimed !== 'number' || typeof result.deletedBlobs !== 'number') {
          throw new Error('Kernel object cleanup returned no reclaimed-byte or deletion receipt');
        }
        return { byteLengthReclaimed: result.byteLengthReclaimed, objectsDeleted: result.deletedBlobs };
      },
      ...(this.options.durableRecoveryStore ? { durableRecoveryStore: this.options.durableRecoveryStore } : {}),
      records,
      working,
      client: scoped,
    };
  }
  async dispose(): Promise<void> {
    const grants = await Promise.allSettled([...this.grants.values()].map(async (grant) => this.client.revokeGrant((await grant).grantId)));
    this.grants.clear();
    const failures = grants.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length > 0) throw new Error(`One or more kernel storage grants failed to revoke: ${failures.map((failure) => String(failure.reason)).join("; ")}`);
  }

  async revokeSession(sessionId: string): Promise<void> {
    const candidates = [...this.grants.entries()];
    for (const [key, promise] of candidates) {
      const grant = await promise.catch(() => null);
      if (!grant || grant.sessionId !== sessionId) continue;
      await this.client.revokeGrant(grant.grantId).catch(() => undefined);
      this.grants.delete(key);
    }
  }
}

export const createKernelWorkspaceWorkingStateAccess = (
  adapter: KernelStorageAdapter,
  recoveryEngine?: WorkspaceRecoveryEngine,
  durableRecoveryStore?: RecoveryDurableOperationPort,
  resolveRecoveryWorkspace?: (owningScopeId: string) => Promise<string>,
): WorkspaceWorkingStateRootAccess => ({
    withBranchStore: async (workspaceId, purpose, operation, _mode: Mode = "exclusive", actor) => {
      const context = await adapter.context(workspaceId, purpose, {
        owningWorkspace: workspaceId,
        executionWorkspace: workspaceId,
        pathScopes: [""],
        ...(actor ?? {}),
        capabilities: actor?.sessionId ? [] : ["storage.maintenance"],
      });
      if (!recoveryEngine) {
        const composed = { ...context, ...(durableRecoveryStore ? { durableRecoveryStore } : {}) };
        return operation(new KernelWorkingStateRootStore(composed), composed);
      }
      return recoveryEngine.withWorkspaceStorage(
        resolveRecoveryWorkspace ? await resolveRecoveryWorkspace(workspaceId) : workspaceId,
        { mode: _mode, purpose, create: true },
        (recoveryContext) => {
          const composed = {
          ...context,
          fileStore: recoveryContext.fileStore,
          resourceOperationGate: recoveryContext.resourceOperationGate,
          ...(recoveryContext.collectUnreachableObjects ? { collectUnreachableObjects: recoveryContext.collectUnreachableObjects } : {}),
          ...(recoveryContext.resolveDirectoryApplyContext ? { resolveDirectoryApplyContext: recoveryContext.resolveDirectoryApplyContext } : {}),
          ...(durableRecoveryStore ? { durableRecoveryStore } : recoveryContext.durableRecoveryStore ? { durableRecoveryStore: recoveryContext.durableRecoveryStore } : {}),
          };
          return operation(new KernelWorkingStateRootStore(composed), composed);
        },
      );
    },
  });
