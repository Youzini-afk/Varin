import { queryTestFiles } from "./file-query.test-helper.js";
import type { WorkingStateFileQuery, WorkingStateQueryOptions, WorkingStateQueryResult } from "./query-contract.js";
import { createHash, randomUUID } from "node:crypto";
import { stableIdentityJson } from "../thread-registry.js";
import fs from "node:fs";
import path from "node:path";
import type { SqliteDatabase } from "../../recovery/journal-catalog.js";
import { sameState } from "../../recovery/journal-files.js";
import type {
  RecoveryState,
  WorkingBranch,
  WorkingBranchRoot,
  WorkingStatePathOrigin,
  WorkingStatePin,
  WorkingStateReadOptions,
  WorkingStateRootStore,
  WorkingStateTreeEntry,
  WorkingStateTreeRead,
  WorkspaceWorkingStateRootAccess,
} from "./types.js";
import { WorkingStateStore, type LocalWorkingStateStorageContext } from "./working-state-store.js";
import type { WorkspaceRecoveryStorageContext } from "../../recovery/journal-engine.js";
import { measurementFromStates } from "./thread-space.js";
import { createInMemoryRecoveryDurablePort, type InMemoryRecoveryDurablePort } from "../../recovery/recovery-durable-port.test-helper.js";

export type TestWorkingStateRootAccess = TestWorkspaceWorkingStateAccess & WorkspaceWorkingStateRootAccess & {
  readonly durableRecoveryStore: InMemoryRecoveryDurablePort;
};

export interface TestWorkspaceWorkingStateAccess {
  withStore<T>(
    workspaceId: string,
    purpose: string,
    operation: (store: WorkingStateStore, context: LocalWorkingStateStorageContext) => Promise<T> | T,
    mode?: "exclusive" | "shared",
  ): Promise<T>;
}

/**
 * Minimal withWorkspaceStorage surface the WorkingStateStore fixtures need.
 * Journal engines satisfy this structurally; tests may also hand a plain
 * object when the store only needs its own object root and catalog.
 */
export interface TestWorkingStateStorageAccess {
  withWorkspaceStorage<T>(
    workspaceId: string,
    options: { mode: "exclusive" | "shared"; purpose: string; create?: boolean },
    operation: (context: LocalWorkingStateStorageContext) => Promise<T> | T,
  ): Promise<T>;
}

/** withStore-compatible access over a fixed WorkingStateStore context. */
export const createWorkingStateStoreContextAccess = (
  context: LocalWorkingStateStorageContext,
): TestWorkingStateStorageAccess => ({
  withWorkspaceStorage: async (_workspaceId, _options, operation) => operation(context),
});

/**
 * Object-store GC for explicit WorkingStateStore context shims: deletes objects
 * under `<root>/objects` no longer referenced by the store's own catalog.
 * Mirrors the retired local engine's collector; production cleanup goes through
 * the kernel durable port.
 */
export const createWorkingStateObjectCollector = (
  root: string,
  database: SqliteDatabase,
): (() => Promise<{ byteLengthReclaimed: number; objectsDeleted: number }>) => async () => {
  const referenced = new Set(
    (database.prepare("SELECT DISTINCT object_hash FROM object_references").all() as Array<{ object_hash: string }>)
      .map((row) => row.object_hash),
  );
  const objectsRoot = path.join(root, "objects");
  let byteLengthReclaimed = 0;
  let objectsDeleted = 0;
  const walk = async (directory: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(target); continue; }
      if (!entry.isFile()) continue;
      const hash = `sha256-${path.relative(objectsRoot, target).replace(/[\\/]/g, "")}`;
      if (referenced.has(hash)) continue;
      byteLengthReclaimed += (await fs.promises.stat(target)).size;
      await fs.promises.rm(target, { force: true });
      objectsDeleted += 1;
    }
  };
  await walk(objectsRoot);
  return { byteLengthReclaimed, objectsDeleted };
};

const normalizeRelative = (value: string): string => {
  const raw = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!raw || raw === ".") return "";
  const segments = raw.split("/").filter((segment) => segment && segment !== ".");
  if (raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || segments.includes("..")) {
    throw new Error(`Invalid working-state path: ${value}`);
  }
  return segments.join("/");
};

const relevantTo = (file: string, roots: readonly string[]): boolean => roots.some((root) => (
  !root || file === root || file.startsWith(`${root}/`) || root.startsWith(`${file}/`)
));

const checkRead = (options?: WorkingStateReadOptions): void => {
  options?.signal?.throwIfAborted();
  if (options?.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
    throw new DOMException("Explore query deadline exceeded", "AbortError");
  }
};

const transientStateIdentity = (states: Record<string, RecoveryState>): string => {
  const hash = createHash("sha256");
  for (const [path, state] of Object.entries(states).sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(path).update("\0").update(stableIdentityJson(state)).update("\0");
  }
  return `sha256-${hash.digest("hex")}`;
};

const rootFromBranch = (branch: WorkingBranch, branchId = branch.branchId, workspaceId = branch.workspaceId): WorkingBranchRoot => ({
  branchId,
  workspaceId,
  ...(branch.baseRef ? { baseRef: branch.baseRef } : {}),
  baseRoot: transientStateIdentity(branch.baseState),
  root: transientStateIdentity({ ...branch.baseState, ...branch.deltas }),
  headRevision: branch.headRevision ?? 0,
  writeRevision: branch.writeRevision ?? 0,
  draftBasePaths: [...(branch.draftBasePaths ?? [])],
  captureScopes: [...(branch.captureScopes ?? [])],
  createdAt: branch.createdAt ? Date.parse(branch.createdAt) : Date.now(),
  updatedAt: branch.updatedAt ? Date.parse(branch.updatedAt) : Date.now(),
});

/** Adapter for the local TS store and its tests. Production implements the root API directly. */
export class LegacyWorkingStateRootAdapter implements WorkingStateRootStore {
  private readonly pins = new Map<string, { branchId: string; revision: number; root: string; states: Record<string, RecoveryState> }>();

  constructor(private readonly store: WorkingStateStore, private readonly context?: WorkspaceRecoveryStorageContext) {}

  async queryFiles(pin: import("./types.js").WorkingStatePinnedRoot, request: WorkingStateFileQuery, options?: WorkingStateQueryOptions): Promise<WorkingStateQueryResult> {
    const state=this.pins.get(pin.pinId);if(!state||state.root!==pin.root)throw new Error("Query pin was released or changed");
    return queryTestFiles(pin,state.states,hash=>this.store.getObject(hash),request,options);
  }

  async getBranchRoot(branchId: string): Promise<WorkingBranchRoot | null> {
    const branch = this.store.getBranch(branchId);
    return branch ? rootFromBranch(branch, branchId, branch.workspaceId ?? this.context?.identity.workspaceId ?? "test") : null;
  }

  async getResult(branchId: string, revision: number): Promise<import("./types.js").WorkingResult | null> {
    const partial = this.store as WorkingStateStore & {
      getResult?: WorkingStateStore["getResult"];
      resultState?: (value: string, resultRevision: number) => Record<string, RecoveryState> | null;
    };
    const result = partial.getResult?.(branchId, revision);
    if (result) return result;
    const pathStates = partial.resultState?.(branchId, revision);
    if (!pathStates) return null;
    const changedPaths = Object.keys(pathStates).sort();
    return {
      branchId,
      resultRevision: revision,
      changedPaths,
      baseStates: Object.fromEntries(changedPaths.map((file) => [file, { kind: "missing" as const }])),
      pathStates,
      diffStats: { files: changedPaths.length, insertions: 0, deletions: 0 },
      createdAt: new Date().toISOString(),
      root: transientStateIdentity(pathStates),
    };
  }

  async readStateSlice(branchId: string, paths: readonly string[], options?: WorkingStateReadOptions): Promise<Record<string, RecoveryState> | null> {
    const state = options?.pin ? this.statesFor(branchId, options) : this.store.effectiveStateSlice(branchId, paths, options?.revision, options);
    return state ? structuredClone(state) : null;
  }

  private statesFor(branchId: string, options?: WorkingStateReadOptions): Record<string, RecoveryState> | null {
    if (options?.pin) {
      const pin = this.pins.get(options.pin.pinId);
      return pin?.branchId === branchId ? structuredClone(pin.states) : null;
    }
    return this.store.effectiveState(branchId, options?.revision);
  }

  private originFor(branchId: string, file: string, state: RecoveryState): WorkingStatePathOrigin {
    const branch = this.store.getBranch(branchId);
    if (!branch) return "base";
    if (branch.draftBasePaths.includes(file) && sameState(branch.baseState[file] ?? { kind: "missing" }, state)) return "draft-base";
    return sameState(branch.baseState[file] ?? { kind: "missing" }, state) ? "base" : "delta";
  }

  async readPath(branchId: string, rawPath: string, options?: WorkingStateReadOptions): Promise<WorkingStateTreeEntry | null> {
    checkRead(options);
    const branch = this.store.getBranch(branchId);
    if (!branch) return null;
    const path = normalizeRelative(rawPath);
    const states = options?.pin
      ? this.statesFor(branchId, options)
      : this.store.effectiveStateSlice(branchId, [path], options?.revision, options);
    if (!states) return null;
    let hidden = false;
    let parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    while (parent) {
      if (states[parent]?.kind === "missing") hidden = true;
      parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : "";
    }
    const state = path && !hidden ? states[path] ?? { kind: "missing" as const } : path ? { kind: "missing" as const } : { kind: "directory" as const };
    const origin = this.originFor(branchId, path, state);
    return {
      path,
      state: structuredClone(state),
      origin,
      root: options?.pin?.root ?? transientStateIdentity(states),
      viewRevision: options?.pin?.writeRevision ?? options?.revision ?? branch.writeRevision,
      ...(state.kind === "regular-file" ? {
        contentSource: options?.pin
          ? { kind: "pin" as const, pinId: options.pin.pinId, path }
          : { kind: "branch" as const, branchId, path, ...(options?.revision === undefined ? {} : { revision: options.revision }) },
      } : {}),
    };
  }

  async listPaths(branchId: string, rawRoots: readonly string[], options?: WorkingStateReadOptions): Promise<WorkingStateTreeRead | null> {
    checkRead(options);
    const branch = this.store.getBranch(branchId);
    if (!branch) return null;
    const roots = (rawRoots.length ? rawRoots : [""]).map(normalizeRelative);
    const states = options?.pin
      ? this.statesFor(branchId, options)
      : this.store.effectiveStateSlice(branchId, roots, options?.revision, options);
    if (!states) return null;
    const entries: WorkingStateTreeEntry[] = [];
    for (const [path, state] of Object.entries(states)) {
      checkRead(options);
      if (!relevantTo(path, roots)) continue;
      const origin = this.originFor(branchId, path, state);
      entries.push({
        path,
        state: structuredClone(state),
        origin,
        ...(state.kind === "regular-file" ? {
          contentSource: options?.pin
            ? { kind: "pin" as const, pinId: options.pin.pinId, path }
            : { kind: "branch" as const, branchId, path, ...(options?.revision === undefined ? {} : { revision: options.revision }) },
        } : {}),
      });
    }
    const root = options?.pin?.root ?? transientStateIdentity(states);
    return {
      branch: rootFromBranch(branch),
      root,
      viewRevision: options?.pin?.writeRevision ?? options?.revision ?? branch.writeRevision,
      entries: entries.sort((left, right) => left.path.localeCompare(right.path)),
    };
  }

  async readContent(entry: WorkingStateTreeEntry, options?: { offset?: number; length?: number }): Promise<Buffer | null> {
    if (entry.state.kind !== "regular-file") return null;
    if (options?.offset !== undefined || options?.length !== undefined) {
      return this.store.getObjectSlice(
        entry.state.objectHash,
        entry.state.byteLength,
        options.offset ?? 0,
        options.length ?? entry.state.byteLength,
      );
    }
    return this.store.getObject(entry.state.objectHash);
  }

  getObject(hash: string): Promise<Buffer | null> { return this.store.getObject(hash); }

  getObjectSlice(hash: string, byteLength: number, offset: number, length: number): Promise<Buffer | null> {
    return this.store.getObjectSlice(hash, byteLength, offset, length);
  }

  ownerIdForObject(hash: string): string | undefined { return (this.store as WorkingStateStore & { ownerIdForObject?: (value: string) => string | undefined }).ownerIdForObject?.(hash); }

  createDraftBaseline(workspaceId: string, paths: readonly { path: string; content: string | Buffer; mode?: number; provenance: import("./types.js").DraftBaselinePathProvenance }[]): Promise<import("./types.js").DraftBaseline> {
    return this.store.createDraftBaseline(workspaceId, paths);
  }

  getDraftBaseline(id: string): Promise<import("./types.js").DraftBaseline | null> { return this.store.getDraftBaseline(id); }

  deleteDraftBaseline(id: string): Promise<void> { return this.store.deleteDraftBaseline(id); }

  async pinBranch(branchId: string, options?: { revision?: number }): Promise<WorkingStatePin> {
    const partial = this.store as WorkingStateStore & {
      getBranch?: WorkingStateStore["getBranch"];
      effectiveStateSlice?: WorkingStateStore["effectiveStateSlice"];
    };
    const storedBranch = partial.getBranch?.(branchId);
    const result = options?.revision === undefined ? null : await this.getResult(branchId, options.revision);
    if (!storedBranch && !result) throw new Error(`Working branch not found: ${branchId}`);
    const revision = options?.revision ?? storedBranch!.writeRevision;
    const states = partial.effectiveStateSlice?.(branchId, [""], options?.revision) ?? result?.pathStates ?? null;
    if (!states) throw new Error(`Working branch revision not found: ${branchId}@${revision}`);
    const root = result?.root ?? transientStateIdentity(states);
    const branch = storedBranch ? rootFromBranch(storedBranch, branchId, storedBranch.workspaceId ?? this.context?.identity.workspaceId ?? "test") : {
      branchId,
      workspaceId: result?.branchId ? this.context?.identity.workspaceId ?? "test" : "test",
      baseRoot: transientStateIdentity(result?.baseStates ?? {}),
      root,
      headRevision: revision,
      writeRevision: revision,
      draftBasePaths: [],
      captureScopes: [],
      createdAt: result?.createdAt ? Date.parse(result.createdAt) : Date.now(),
      updatedAt: result?.createdAt ? Date.parse(result.createdAt) : Date.now(),
    };
    const pinId = `local-pin-${randomUUID()}`;
    this.pins.set(pinId, { branchId, revision, root, states });
    return {
      pinId,
      branchId,
      workspaceId: branch.workspaceId,
      view: options?.revision === undefined ? "current" : "revision",
      revision,
      writeRevision: revision,
      root,
      branch,
      release: async () => { this.pins.delete(pinId); },
    };
  }

  putObject(bytes: Buffer): Promise<{ hash: string; byteLength: number }> {
    return this.store.putObject(bytes);
  }

  commitVirtualWrites(branchId: string, expectedWriteRevision: number, files: Record<string, RecoveryState>) {
    return this.store.commitVirtualWrites(branchId, expectedWriteRevision, files);
  }

  rebaseBranch(branchId: string, expectedWriteRevision: number, rebase: { baseRef: string; parentRef?: string; baseState?: Record<string, RecoveryState>; changes: Record<string, RecoveryState> }) {
    const baseState = rebase.baseState ?? this.pins.get(rebase.baseRef)?.states;
    return this.store.rebaseBranch(branchId, expectedWriteRevision, {
      ...rebase,
      ...(baseState === undefined ? {} : { baseState }),
    });
  }

  async createBranch(workspaceId: string, branchId: string, baseState: Record<string, RecoveryState>, baseRef?: string, draftBasePaths: string[] = [], captureScopes: string[] = []): Promise<WorkingBranchRoot> {
    const created = await this.store.createBranch(workspaceId, branchId, baseState, baseRef, draftBasePaths, captureScopes);
    if (created?.branchId && created.baseState) return rootFromBranch(created);
    const root = transientStateIdentity(baseState);
    return {
      branchId,
      workspaceId,
      ...(baseRef ? { baseRef } : {}),
      baseRoot: root,
      root,
      headRevision: created?.headRevision ?? 0,
      writeRevision: created?.writeRevision ?? 0,
      draftBasePaths: [...(created?.draftBasePaths ?? draftBasePaths)],
      captureScopes: [...(created?.captureScopes ?? captureScopes)],
      createdAt: created?.createdAt ? Date.parse(created.createdAt) : Date.now(),
      updatedAt: created?.updatedAt ? Date.parse(created.updatedAt) : Date.now(),
    };
  }

  async createBranchFromPin(workspaceId: string, branchId: string, pin: WorkingStatePin, parentRef: string, draftBaselineId?: string | null, captureScopes: string[] = []): Promise<WorkingBranchRoot> {
    const pinned = this.pins.get(pin.pinId);
    if (!pinned) throw new Error(`Working-state pin is unavailable: ${pin.pinId}`);
    const draft = draftBaselineId ? await this.store.getDraftBaseline(draftBaselineId) : null;
    const draftPaths = draft ? Object.keys(draft.pathStates) : [];
    await this.store.createBranch(workspaceId, branchId, pinned.states, parentRef, draftPaths, captureScopes);
    if (draft && Object.keys(draft.pathStates).length > 0) await this.store.commitVirtualWrites(branchId, 0, draft.pathStates);
    const branch = this.store.getBranch(branchId);
    if (!branch) throw new Error(`Working branch not found after creation: ${branchId}`);
    return rootFromBranch(branch);
  }

  async releaseCapturedStates(_states: Record<string, RecoveryState>): Promise<void> { /* The test object store has no transient owner leases. */ }

  captureDirectory(...args: Parameters<WorkingStateStore["captureDirectory"]>): ReturnType<WorkingStateStore["captureDirectory"]> { return this.store.captureDirectory(...args); }
  async listCaptureScopePaths(directory: string, scopes: readonly string[]): Promise<string[]> {
    if (typeof this.store.listCaptureScopePaths === "function") return this.store.listCaptureScopePaths(directory, scopes);
    const paths = await this.listWorkspaceBaselinePaths(directory);
    return paths.filter((file) => scopes.some((scope) => file === scope || file.startsWith(`${scope}/`))).sort();
  }
  async listWorkspaceBaselinePaths(directory: string): Promise<string[]> {
    if (typeof this.store.listWorkspaceBaselinePaths === "function") return this.store.listWorkspaceBaselinePaths(directory);
    return [];
  }

  materializeResult(...args: Parameters<WorkingStateStore["materializeResult"]>): ReturnType<WorkingStateStore["materializeResult"]> { return this.store.materializeResult(...args); }
  async materializePin(pin: WorkingStatePin, directory: string): Promise<import("./materializer.js").MaterializeResult> {
    const pinned = this.pins.get(pin.pinId);
    if (!pinned) throw new Error(`Working-state pin is unavailable: ${pin.pinId}`);
    return this.store.materializeStates(pinned.states, directory);
  }
  async measurePin(pin: WorkingStatePin): Promise<import("@varin/protocol").ThreadSpaceMeasurement> {
    const pinned = this.pins.get(pin.pinId);
    if (!pinned) throw new Error(`Working-state pin is unavailable: ${pin.pinId}`);
    return measurementFromStates(pinned.states);
  }
  directoryMatchesResult(...args: Parameters<WorkingStateStore["directoryMatchesResult"]>): ReturnType<WorkingStateStore["directoryMatchesResult"]> { return this.store.directoryMatchesResult(...args); }
  captureBranchCandidateIdentity(...args: Parameters<WorkingStateStore["captureBranchCandidateIdentity"]>): ReturnType<WorkingStateStore["captureBranchCandidateIdentity"]> { return this.store.captureBranchCandidateIdentity(...args); }
  captureSeededPathIdentity(...args: Parameters<WorkingStateStore["captureSeededPathIdentity"]>): ReturnType<WorkingStateStore["captureSeededPathIdentity"]> { return this.store.captureSeededPathIdentity(...args); }
  async readOriginalSource(_branchId: string): Promise<import("./types.js").WorkingOriginalSource | null> { return null; }
  async readSourcePreparation(_branchId: string): Promise<import("./types.js").WorkingSourcePreparation | null> { return null; }
  async readResultCandidate(_branchId: string, _publicationId: string): Promise<import("./types.js").WorkingResultCandidate | null> { return null; }
  async prepareResultCandidate(_input: import("./types.js").PrepareWorkingResultCandidate): Promise<import("./types.js").WorkingResultCandidate> {
    throw new Error("Durable publication candidates require the Rust WorkingState owner");
  }
  async publishPreparedResult(_publicationId: string, _candidate: import("./types.js").WorkingResultCandidate): Promise<import("./types.js").WorkingResult> {
    throw new Error("Durable publication candidates require the Rust WorkingState owner");
  }
  async resumeResultPublication(_branchId: string, _publicationId: string): Promise<import("./types.js").WorkingResult | null> {
    // This legacy isolated fixture never writes the Rust operation log.
    return null;
  }
  publishHeadResult(...args: Parameters<WorkingStateStore["publishHeadResult"]>): ReturnType<WorkingStateStore["publishHeadResult"]> { return this.store.publishHeadResult(...args); }
  publishDirectoryResult(...args: Parameters<WorkingStateStore["publishDirectoryResult"]>): ReturnType<WorkingStateStore["publishDirectoryResult"]> { return this.store.publishDirectoryResult(...args); }
  async resultTreeIdentity(branchId: string, revision: number): Promise<string | null> { return this.store.resultTreeIdentity(branchId, revision); }
  async listResults(branchId?: string): Promise<import("./types.js").WorkingResult[]> { return this.store.listResults(branchId); }
  deleteResults(branchId: string, revisions: readonly number[]): Promise<number[]> { return this.store.deleteResults(branchId, revisions); }
  deleteBranch(branchId: string): Promise<void> { return this.store.deleteBranch(branchId); }
  async collectUnreachableObjects(): Promise<{ byteLengthReclaimed: number; objectsDeleted: number }> {
    if (!this.context?.collectUnreachableObjects) throw new Error("Object cleanup is unavailable");
    return this.context.collectUnreachableObjects();
  }
  async listDurableOperations(kind?: string): Promise<Record<string, unknown>[]> {
    return this.context?.durableRecoveryStore.listOperations(this.context.identity.workspaceId, kind) ?? [];
  }
  async listBranchObjectReferences(branchId: string): Promise<Array<{ hash: string; byteLength: number | null }>> {
    const hashes = new Map<string, number | null>();
    const add = (state: RecoveryState): void => { if (state.kind === "regular-file" && !hashes.has(state.objectHash)) hashes.set(state.objectHash, state.byteLength); };
    const branch = this.store.getBranch(branchId);
    if (branch) for (const state of [...Object.values(branch.baseState), ...Object.values(branch.deltas)]) add(state);
    for (const result of this.store.listResults(branchId)) for (const state of [...Object.values(result.baseStates), ...Object.values(result.pathStates)]) add(state);
    return [...hashes].map(([hash, byteLength]) => ({ hash, byteLength }));
  }
  async listDraftObjectReferences(id: string): Promise<Array<{ hash: string; byteLength: number | null }>> {
    const draft = await this.store.getDraftBaseline(id);
    return draft ? Object.values(draft.pathStates).flatMap((state) => state.kind === "regular-file" ? [{ hash: state.objectHash, byteLength: state.byteLength }] : []) : [];
  }
  async listChildVerifications(threadId: string): Promise<import("./types.js").ResultVerificationBundle[]> { return this.store.listChildVerifications(threadId); }
  async listParentVerifications(threadId: string): Promise<import("./types.js").ParentVerificationBundle[]> { return this.store.listParentVerifications(threadId); }
  async listReviewRecords(threadId: string): Promise<import("./types.js").ResultReviewRecord[]> { return this.store.listReviewRecords(threadId); }
  async getChildVerification(threadId: string, revision: number): Promise<import("./types.js").ResultVerificationBundle | null> { return this.store.getChildVerification(threadId, revision); }
  async getParentVerification(threadId: string, revision?: number): Promise<import("./types.js").ParentVerificationBundle | null> { return this.store.getParentVerification(threadId, revision); }
  async getReviewRecord(threadId: string, revision: number): Promise<import("./types.js").ResultReviewRecord | null> { return this.store.getReviewRecord(threadId, revision); }
  async putChildVerification(threadId: string, bundle: import("./types.js").ResultVerificationBundle): Promise<void> { await this.store.putChildVerification(threadId, bundle); }
  async putParentVerification(threadId: string, _branchId: string, bundle: import("./types.js").ParentVerificationBundle): Promise<void> { await this.store.putParentVerification(threadId, bundle); }
  async putReviewRecord(threadId: string, _branchId: string, record: import("./types.js").ResultReviewRecord): Promise<void> { await this.store.putReviewRecord(threadId, record); }
}

export const asTestWorkingStateRootStore = (
  store: WorkingStateStore,
  context?: WorkspaceRecoveryStorageContext | LocalWorkingStateStorageContext,
): WorkingStateRootStore => new LegacyWorkingStateRootAdapter(store, context as unknown as WorkspaceRecoveryStorageContext);

export const asTestWorkingStateRootAccess = (
  access: TestWorkspaceWorkingStateAccess,
  durableRecoveryStore: InMemoryRecoveryDurablePort = createInMemoryRecoveryDurablePort(),
): TestWorkingStateRootAccess => {
  const memoryDurable = durableRecoveryStore;
  return {
    ...access,
    durableRecoveryStore: memoryDurable,
    withBranchStore: (workspaceId, purpose, operation, mode = "exclusive") => access.withStore(
      workspaceId,
      purpose,
      (store, context) => {
        const legacyContext = context;
        const rootContext = {
          ...legacyContext,
          identity: legacyContext?.identity ?? { authorityId: "test", canonicalRoot: "", filesystemProfile: "test", workspaceId },
          durableRecoveryStore: memoryDurable,
        } as WorkspaceRecoveryStorageContext;
        return operation(new LegacyWorkingStateRootAdapter(store, rootContext), rootContext);
      },
      mode,
    ),
  };
};

export const createTestWorkingStateRootAccess = (
  recovery: TestWorkingStateStorageAccess,
  durableRecoveryStore: InMemoryRecoveryDurablePort = createInMemoryRecoveryDurablePort(),
): TestWorkingStateRootAccess => asTestWorkingStateRootAccess({
  withStore: (workspaceId, purpose, operation, mode = "exclusive") => recovery.withWorkspaceStorage(
    workspaceId,
    { mode, purpose },
    async (context) => operation(await WorkingStateStore.open(context as never), context),
  ),
}, durableRecoveryStore);
