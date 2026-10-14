/**
 * Durable input and execution directories for experiments.
 *
 * The Rust kernel owns both sides of this boundary.  A submission captures
 * the source directory into an immutable branch/root; an attempt is then
 * materialized into its own directory below the kernel storage root.  This
 * module deliberately does not copy bytes or create a working tree from TypeScript.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { KernelBranchState, KernelObjectSlice, LaunchSource } from "../kernel/protocol.generated.js";
import { KernelClientError, type KernelClient, type KernelScopedClient } from "../kernel/kernel-client.js";
import { canonicalizePathIdentity, isPathWithinRoot } from "../workspace/path-safety.js";

import { ExperimentPreparationError } from "./experiment-backend.js";
import { waitWithSignal } from "../cancellation.js";

const MANAGED_EXPERIMENTS_DIRECTORY = path.join("managed", "experiments");
const CAPTURE_EXCLUDED_DIRECTORIES = [".git", ".varin"] as const;

export interface ExperimentWorkspaceCaller {
  /** Workspace that owns the durable experiment/spec facts and source branch. */
  workspaceId: string;
  /** Explicit execution identity. It is never inferred from workspaceId. */
  executionWorkspaceId: string;
  owner: { runtime: 'agent'; threadId: string; runId: string; operationId?: string };
}

export interface PrepareExperimentInputOptions {
  /** Exact native source grant; owned by the caller until the actual capture drains. */
  sourceAuthority?: { scoped: KernelScopedClient; rootId: string };
  /** Relative source directories/files explicitly admitted by the caller. `[]` means the root. */
  captureScopes?: readonly string[];
  /** Working directory relative to the captured source root. */
  cwd?: string;
  signal?: AbortSignal;
  /** Original attempt-owned identity; a lost create reply is recovered through operation.get. */
  branchId?: string;
  beforeBranchCreate?: (capture: ExperimentInputCapture) => Promise<void>;
}

/** Reports whether this flight actually dispatched the original candidate-branch create. */
export class ExperimentInputCaptureError extends ExperimentPreparationError {
  constructor(message: string, readonly branchCreateDispatched: boolean, options: { drained: boolean; retryable: boolean; cause: unknown }) {
    super(message, options);
    this.name = "ExperimentInputCaptureError";
  }
}

export type ExperimentInputCapture = Omit<ExperimentInputSnapshot, "root">;

export interface ExperimentInputSnapshot {
  schemaVersion: 2;
  branchId: string;
  /** Immutable root returned by branch creation. This is the durable spec input. */
  root: string;
  sourceRoot: string | null;
  workspaceId: string;
  executionWorkspaceId: string;
  captureScopes: string[];
  capturedPathCount: number | null;
  inventoryFingerprint: string | null;
  /** The source file authority does not apply Git ignore rules. */
  source: ExperimentInputOrigin | { kind: 'managed-source'; selection: LaunchSource; origin: ExperimentInputOrigin;
    sourceBranchId: string; resourceEpoch: string };
  captureSemantics: {
    excludedDirectories: readonly [".git", ".varin"];
    gitignore: "not-applied";
    ignoredFilesIncluded: true;
  } | null;
  cwd?: string;
}
export type ExperimentInputOrigin = { kind: 'physical-capture' } | { kind: 'fixed-branch'; branchId: string; revision: number; root: string };

export interface MaterializedExperimentAttempt {
  attemptId: string;
  branchId: string;
  /** Immutable branch root used as the materialization source. */
  snapshotRoot: string;
  /** Ephemeral execution grant; do not persist it with the spec/attempt record. */
  scoped: KernelScopedClient;
  /** Held by the returned backend until its actual job and output readers finish. */
  releaseAuthority(): Promise<void>;
  /** Root registration for this attempt directory, suitable for process.spawn. */
  rootId: string;
  canonicalRoot: string;
  /** Process cwd relative to canonicalRoot. */
  cwd: string;
  /** The Rust-managed container root used by file.materialize. */
  containerRootId: string;
  managedRoot: string;
  materialized: true;
}

export interface ExperimentInputTransfer {
  /** Close only after all returned content readers settle. */
  close(): Promise<void>;
  materialId: string;
  cwd?: string;
  entries: Array<{ path: string; state: KernelBranchState }>;
  readObject(objectHash: string, byteLength: number, signal?: AbortSignal): AsyncIterable<Uint8Array>;
}

interface CapturedEntry {
  path: string;
  state: KernelBranchState;
  /** State observed from the live source, retained for the post-capture check. */
  sourceState: KernelBranchState;
  ownerId?: string;
}

const asNonEmptyString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
};

const assertCaller = (caller: ExperimentWorkspaceCaller): void => {
  asNonEmptyString(caller.workspaceId, "Experiment owning workspace identity");
  // Do not use `caller.workspaceId` as a fallback here. An invalid execution
  // identity must stop the operation instead of silently widening authority.
  asNonEmptyString(caller.executionWorkspaceId, "Experiment execution workspace identity");
  if (caller.owner?.runtime !== "agent") throw new Error("Original native experiment owner is required");
  asNonEmptyString(caller.owner.threadId, "Experiment Thread identity");
  asNonEmptyString(caller.owner.runId, "Experiment Run identity");
};

const normalizeRelative = (value: string, label: string): string => {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid`);
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized === ".") return "";
  const parts = normalized.split("/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized) || parts.includes("..")) {
    throw new Error(`${label} must stay inside the source root: ${value}`);
  }
  return parts.filter((part) => part && part !== ".").join("/");
};

const pathFor = (root: string, relative: string): string => (
  relative ? path.resolve(root, ...relative.split("/")) : path.resolve(root)
);

const stableState = (state: KernelBranchState): string => JSON.stringify(state);

const parseState = (value: unknown, relative: string): KernelBranchState => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Kernel returned an invalid captured state for ${relative}`);
  }
  const state = value as Record<string, unknown>;
  switch (state.kind) {
    case "regular-file":
      if (typeof state.objectHash !== "string" || !state.objectHash.startsWith("sha256-")
        || !Number.isSafeInteger(state.byteLength) || Number(state.byteLength) < 0
        || !Number.isSafeInteger(state.mode)) {
        throw new Error(`Kernel returned an invalid regular-file state for ${relative}`);
      }
      return {
        kind: "regular-file",
        objectHash: state.objectHash,
        byteLength: Number(state.byteLength),
        mode: Number(state.mode),
      };
    case "directory":
      return {
        kind: "directory",
        ...(Number.isSafeInteger(state.mode) ? { mode: Number(state.mode) } : {}),
      };
    case "symlink":
      if (typeof state.symlinkTarget !== "string") throw new Error(`Kernel returned an invalid symlink state for ${relative}`);
      return {
        kind: "symlink",
        symlinkTarget: state.symlinkTarget,
        ...(Number.isSafeInteger(state.mode) ? { mode: Number(state.mode) } : {}),
      };
    case "missing":
      throw new Error(`Captured source path disappeared: ${relative}`);
    case "unsupported":
      throw new Error(`Unsupported source file cannot be used as experiment input: ${relative}`);
    default:
      throw new Error(`Kernel returned an unknown captured state for ${relative}`);
  }
};

const captureState = (value: Record<string, unknown>, expectedPath: string, requireOwner = true): { path: string; state: KernelBranchState; ownerId?: string } => {
  if (typeof value.path !== "string" || value.path !== expectedPath || typeof value.stateJson !== "string") {
    throw new Error(`Kernel returned an invalid file capture result for ${expectedPath}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(value.stateJson); } catch { throw new Error(`Kernel returned malformed state JSON for ${expectedPath}`); }
  const state = parseState(parsed, expectedPath);
  const ownerId = typeof value.ownerId === "string" && value.ownerId.length > 0 ? value.ownerId : undefined;
  if (requireOwner && state.kind === "regular-file" && !ownerId) {
    throw new Error(`Kernel did not return an object owner for captured input: ${expectedPath}`);
  }
  return { path: expectedPath, state, ...(ownerId ? { ownerId } : {}) };
};

const issueExperimentGrant = async (
  client: KernelClient,
  caller: ExperimentWorkspaceCaller,
  purpose: string,
  signal?: AbortSignal,
): Promise<{ scoped: KernelScopedClient; release(): Promise<void> }> => {
  assertCaller(caller);
  signal?.throwIfAborted();
  await client.start();
  const grant = await client.issueGrant({
    grantId: `experiment-workspace:${purpose}:${randomUUID()}`,
    owningWorkspace: caller.workspaceId,
    executionWorkspace: caller.executionWorkspaceId,
    threadId: caller.owner.threadId,
    runId: caller.owner.runId,
    operationId: caller.owner.operationId,
    capabilities: purpose === "materialize"
      ? ["storage.read", "storage.write", "recovery", "recovery.maintenance", "process", "process.maintenance"]
      : ["storage.read", "storage.write"],
    // The root registration is the authority boundary. Materialization also
    // requires an unbounded source-view grant, hence the explicit empty scope.
    pathScopes: [""],
  }, signal);
  let released=false;
  return { scoped: client.scoped(grant), async release(){if(released)return;await client.retireGrant(grant.grantId);released=true;} };
};

const scanInventory = async (
  scoped: KernelScopedClient,
  workspaceId: string,
  rootId: string,
  scopes: readonly string[],
  leaseId: string,
  observe: <T>(read: () => Promise<T>) => Promise<T>,
  signal?: AbortSignal,
): Promise<{ paths: string[]; fingerprint: string }> => {
  const paths: string[] = [];
  let cursor: number | undefined;
  let fingerprint: string | undefined;
  do {
    signal?.throwIfAborted();
    const page = await observe(() => scoped.fileScan({
      workspaceId,
      rootId,
      leaseId,
      path: "",
      pageSize: 1024,
      ...(scopes.length > 0 ? { scopes: [...scopes] } : {}),
      ...(cursor === undefined ? {} : { cursor }),
      ...(fingerprint === undefined ? {} : { expectedFingerprint: fingerprint }),
    }, signal));
    if (!Array.isArray(page.paths) || !page.paths.every((entry) => typeof entry === "string")) {
      throw new Error("Kernel returned an invalid experiment input scan page");
    }
    if (typeof page.fingerprint !== "string" || page.fingerprint.length === 0) {
      throw new Error("Kernel returned no experiment input inventory fingerprint");
    }
    fingerprint ??= page.fingerprint;
    if (page.fingerprint !== fingerprint) throw new Error("Experiment input inventory changed while scanning");
    paths.push(...page.paths as string[]);
    const next = typeof page.nextCursor === "number" ? page.nextCursor : undefined;
    if (next !== undefined && (next <= (cursor ?? -1) || next > paths.length)) {
      throw new Error("Kernel returned an invalid experiment input scan cursor");
    }
    cursor = next;
  } while (cursor !== undefined);
  if (fingerprint === undefined) throw new Error("Kernel returned an empty experiment input inventory identity");
  const unique = new Set(paths);
  if (unique.size !== paths.length) throw new Error("Kernel returned duplicate experiment input paths");
  return { paths, fingerprint };
};

const releaseOwners = async (scoped: KernelScopedClient, owners: Iterable<string>): Promise<void> => {
  await Promise.allSettled([...new Set(owners)].map((ownerId) => scoped.releaseBlob(ownerId)));
};

const assertInRoot = (candidate: string, root: string, label: string): void => {
  if (!isPathWithinRoot(candidate, root)) throw new Error(`${label} is outside the source root`);
};

const symlinkStateForSnapshot = async (
  root: string,
  relative: string,
  state: KernelBranchState,
  capturedPaths: readonly string[],
): Promise<KernelBranchState> => {
  if (state.kind !== "symlink") return state;
  const source = pathFor(root, relative);
  const target = path.resolve(path.dirname(source), state.symlinkTarget);
  let resolved: string;
  try { resolved = await canonicalizePathIdentity(target); } catch (error) {
    throw new Error(`Experiment input symlink cannot be resolved: ${relative} (${error instanceof Error ? error.message : String(error)})`);
  }
  assertInRoot(resolved, root, `Experiment input symlink ${relative}`);
  const targetRelative = path.relative(root, resolved).replaceAll("\\", "/");
  if (targetRelative && !capturedPaths.includes(targetRelative)) {
    throw new Error(`Experiment input symlink target is outside the captured tree: ${relative}`);
  }
  const snapshotTarget = path.relative(path.dirname(source), resolved).replaceAll("\\", "/");
  if (!snapshotTarget || snapshotTarget === ".") {
    throw new Error(`Experiment input symlink target is not materializable: ${relative}`);
  }
  // An absolute source link is converted to a relative link in the immutable
  // snapshot. Otherwise materialization would recreate a link into the live
  // source tree and violate attempt isolation.
  return { ...state, symlinkTarget: snapshotTarget };
};

const validateScope = async (root: string, relative: string): Promise<void> => {
  const absolute = pathFor(root, relative);
  const metadata = await fs.lstat(absolute);
  if (metadata.isSymbolicLink()) throw new Error(`Experiment capture scope cannot be a symlink: ${relative}`);
  const resolved = await canonicalizePathIdentity(absolute);
  assertInRoot(resolved, root, `Experiment capture scope ${relative}`);
};

const validateCwd = async (root: string, cwd: string, inventory: readonly string[]): Promise<void> => {
  const absolute = pathFor(root, cwd);
  const metadata = await fs.stat(absolute);
  if (!metadata.isDirectory()) throw new Error(`Experiment cwd is not a directory: ${cwd}`);
  const resolved = await canonicalizePathIdentity(absolute);
  assertInRoot(resolved, root, `Experiment cwd ${cwd}`);
  if (!cwd) return;
  if (!inventory.some((entry) => entry === cwd || entry.startsWith(`${cwd}/`))) {
    throw new Error(`Experiment cwd is outside the captured input scopes: ${cwd}`);
  }
};

const encodedPathSegment = (value: string, label: string): string => {
  if (!value || value.includes("\0")) throw new Error(`${label} is invalid`);
  // Prefix a reversible binary encoding so values such as "." and ".."
  // cannot collapse the managed path through path.resolve normalization.
  return `id-${Buffer.from(value, "utf8").toString("base64url")}`;
};

const managedAttemptPath = (storageRoot: string, workspaceId: string, attemptId: string): { managedRoot: string; attemptRoot: string } => {
  const managedRoot = path.resolve(storageRoot, MANAGED_EXPERIMENTS_DIRECTORY);
  const attemptRoot = path.resolve(
    managedRoot,
    encodedPathSegment(workspaceId, "Experiment workspace identity"),
    encodedPathSegment(attemptId, "Experiment attempt identity"),
  );
  assertInRoot(attemptRoot, managedRoot, "Experiment attempt directory");
  return { managedRoot, attemptRoot };
};

/** Capture code/data into a durable immutable branch/root for an experiment spec. */
export async function prepareExperimentInput(
  client: KernelClient,
  caller: ExperimentWorkspaceCaller,
  canonicalRoot: string,
  options: PrepareExperimentInputOptions = {},
): Promise<ExperimentInputSnapshot> {
  let ownGrant: Awaited<ReturnType<typeof issueExperimentGrant>> | undefined;
  let captureDrained = true;
  let branchCreateUncertain = false;
  let branchCreateDispatched = false;
  try {
    assertCaller(caller);
    options.signal?.throwIfAborted();
    const sourceRoot = await canonicalizePathIdentity(asNonEmptyString(canonicalRoot, "Experiment source root"));
    if (sourceRoot !== canonicalRoot) throw new Error("Experiment source root identity changed after admission");
    if (!options.captureScopes) throw new Error("Experiment capture scopes must be explicit caller-authorized paths");
    const scopes = [...new Set(options.captureScopes.map((entry) => normalizeRelative(entry, "Experiment capture scope")))].sort();
    for (const scope of scopes) await validateScope(sourceRoot, scope);
    const cwd = options.cwd === undefined ? undefined : normalizeRelative(options.cwd, "Experiment cwd");
    if (!options.sourceAuthority) ownGrant = await issueExperimentGrant(client, caller, "prepare", options.signal);
    const scoped = options.sourceAuthority?.scoped ?? ownGrant!.scoped;
    const registered = await scoped.fileRootRegister({
      workspaceId: caller.workspaceId,
      executionWorkspaceId: caller.executionWorkspaceId,
      canonicalRoot: sourceRoot,
    }, options.signal);
    const sourceRootId = registered.rootId;
    if (options.sourceAuthority && sourceRootId !== options.sourceAuthority.rootId) throw new Error("Native source root differs from its grant");
    const leaseId = `experiment-input-lease:${randomUUID()}`;
    for (;;) {
      options.signal?.throwIfAborted();
      const lease = await scoped.fileLeaseAcquire({ workspaceId: caller.workspaceId, rootId: sourceRootId, leaseId,
        resources: (scopes.length ? scopes : [""]).map((entry) => ({ path: entry, scope: "subtree" })) });
      if (lease.status === "acquired") break;
      if (lease.status !== "busy") throw new Error("Experiment input source lease returned no admission fact");
      await waitWithSignal(new Promise<void>((resolve) => setTimeout(resolve, 250)), options.signal);
    }
    try {
      // All source workers share the caller's existing lease and actual-response
      // drain tracking. A disconnected transport is not a stopped reader receipt.
      const observe = async <T>(read: () => Promise<T>): Promise<T> => {
        options.signal?.throwIfAborted();
        captureDrained = false;
        try {
          const result = await read();
          captureDrained = true;
          return result;
        } catch (error) {
          if (error instanceof KernelClientError && error.code === "cancelled") captureDrained = true;
          throw error;
        }
      };
      const capturePath = async (relative: string, store: boolean): Promise<Record<string, unknown>> => {
        const result = await observe(() => scoped.fileCaptureBatch({ operationId: `experiment-input-${store ? "capture" : "verify"}:${randomUUID()}`,
          workspaceId: caller.workspaceId, rootId: sourceRootId, paths: [relative], store, leaseId }, options.signal));
        if (!Array.isArray(result.entries) || result.entries.length !== 1 || !result.entries[0] || typeof result.entries[0] !== "object") throw new Error("Kernel returned an invalid experiment input capture batch");
        return result.entries[0] as Record<string, unknown>;
      };
      const inventory = await scanInventory(scoped, caller.workspaceId, sourceRootId, scopes, leaseId, observe, options.signal);
      if (cwd !== undefined) await validateCwd(sourceRoot, cwd, inventory.paths);

      const entries: CapturedEntry[] = [];
      let createdBranchId: string | undefined;
      try {
        for (const relative of inventory.paths) {
          options.signal?.throwIfAborted();
          const value = await capturePath(relative, true);
          const captured = captureState(value, relative);
          const snapshotState = await symlinkStateForSnapshot(sourceRoot, relative, captured.state, inventory.paths);
          entries.push({ ...captured, state: snapshotState, sourceState: captured.state });
        }

        // The list fingerprint protects scan pagination, while this fresh scan
        // catches additions/removals during the capture window.
        const afterInventory = await scanInventory(scoped, caller.workspaceId, sourceRootId, scopes, leaseId, observe, options.signal);
        if (afterInventory.fingerprint !== inventory.fingerprint
          || afterInventory.paths.length !== inventory.paths.length
          || afterInventory.paths.some((entry, index) => entry !== inventory.paths[index])) {
          throw new Error("Experiment source changed while its input snapshot was being captured");
        }

        // A path inventory does not include file bytes. Re-observe every captured
        // path so a multi-file snapshot cannot silently mix two live generations.
        for (const entry of entries) {
          options.signal?.throwIfAborted();
          const observed = await capturePath(entry.path, false);
          const verified = captureState(observed, entry.path, false);
          if (stableState(verified.state) !== stableState(entry.sourceState)) {
            throw new Error(`Experiment source changed while capturing: ${entry.path}`);
          }
          await symlinkStateForSnapshot(sourceRoot, entry.path, verified.state, inventory.paths);
        }

        const branchId = options.branchId ?? `experiment-input-${randomUUID()}`;
        const capture: ExperimentInputCapture = {
          schemaVersion: 2, branchId, sourceRoot, source: { kind: "physical-capture" },
          workspaceId: caller.workspaceId, executionWorkspaceId: caller.executionWorkspaceId,
          captureScopes: scopes, capturedPathCount: inventory.paths.length,
          inventoryFingerprint: inventory.fingerprint,
          captureSemantics: { excludedDirectories: CAPTURE_EXCLUDED_DIRECTORIES, gitignore: "not-applied", ignoredFilesIncluded: true },
          ...(cwd ? { cwd } : {}),
        };
        await options.beforeBranchCreate?.(capture);
        options.signal?.throwIfAborted();
        branchCreateUncertain = true;
        branchCreateDispatched = true;
        // This short metadata commit keeps its actual ACK; cancelling the caller must not lose its ownership receipt.
        const created = await scoped.createBranch({
          operationId: `experiment-input-branch:${branchId}`,
          branchId,
          workspaceId: caller.workspaceId,
          entries: entries.map(({ path: entryPath, state, ownerId }) => ({
            path: entryPath,
            state,
            ...(ownerId ? { ownerId } : {}),
          })),
          draftBasePaths: [],
          captureScopes: scopes,
        });
        branchCreateUncertain = false;
        if (created.created === true) createdBranchId = branchId;
        const root = typeof created.root === "string" ? created.root : "";
        if (!root || created.branchId !== branchId) throw new Error("Kernel returned an invalid experiment input branch");
        const branch = await scoped.readBranch({ branchId }, options.signal);
        if (branch.workspaceId !== caller.workspaceId || branch.root !== root || branch.currentRoot !== root) {
          throw new Error("Experiment input branch changed while it was being created");
        }
        return { ...capture, root };
      } catch (error) {
        // If branch creation succeeded but the post-create provenance check failed,
        // remove only the branch allocated by this call before releasing any
        // remaining temporary owners. A `created:false` response is never deleted.
        if (createdBranchId && !options.branchId) {
          await scoped.deleteBranch({
            operationId: `experiment-input-branch-cleanup:${createdBranchId}:${randomUUID()}`,
            branchId: createdBranchId,
          }).catch(() => undefined);
        }
        await releaseOwners(scoped, entries.flatMap((entry) => entry.ownerId ? [entry.ownerId] : []));
        throw error;
      }
    } finally {
      await scoped.fileLeaseRelease({ workspaceId: caller.workspaceId, rootId: sourceRootId, leaseId });
    }
  } catch (error) {
    throw new ExperimentInputCaptureError(error instanceof Error ? error.message : String(error), branchCreateDispatched, { drained: captureDrained, retryable: !captureDrained || branchCreateUncertain || error instanceof KernelClientError, cause: error });
  } finally { if(captureDrained) await ownGrant?.release(); }
}
/** Recover only the original create receipt; a missing/changed committed branch is never recaptured. */
export async function recoverExperimentInput(client: KernelClient, caller: ExperimentWorkspaceCaller, capture: ExperimentInputCapture, signal?: AbortSignal): Promise<ExperimentInputSnapshot | null> {
  const grant = await issueExperimentGrant(client, caller, "prepare", signal);
  const { scoped } = grant;
  try {
    const receipt = await scoped.getOperation(`experiment-input-branch:${capture.branchId}`, signal);
    if (receipt === null)
      return null;
    const result = receipt.result;
    if (receipt.state !== "committed" || !result || typeof result !== "object") {
      throw new Error("Experiment input branch creation has no confirmed immutable result");
    }
    const created = result as Record<string, unknown>;
    if (created.branchId !== capture.branchId || typeof created.root !== "string" || !created.root) {
      throw new Error("Experiment input branch receipt is unreadable");
    }
    const branch = await scoped.readBranch({ branchId: capture.branchId }, signal);
    if (branch.workspaceId !== caller.workspaceId || branch.root !== created.root || branch.currentRoot !== created.root) {
      throw new Error("Experiment input branch no longer matches its committed create receipt");
    }
    return { ...capture, root: created.root };
  }
  finally {
    await grant.release();
  }
}
/** Materialize one independent attempt directory from the spec's immutable root. */
export async function materializeExperimentAttempt(client: KernelClient, caller: ExperimentWorkspaceCaller, attemptId: string, input: ExperimentInputSnapshot, options: {
  signal?: AbortSignal;
} = {}): Promise<MaterializedExperimentAttempt> {
  let grant: Awaited<ReturnType<typeof issueExperimentGrant>> | undefined;
  let transferred = false;
  let materializationDispatched = false;
  let materializationDrained = false;
  try {
    assertCaller(caller);
    if (caller.workspaceId !== input.workspaceId || caller.executionWorkspaceId !== input.executionWorkspaceId) {
      throw new Error("Experiment execution identity does not match the input snapshot");
    }
    asNonEmptyString(input.branchId, "Experiment input branch identity");
    asNonEmptyString(input.root, "Experiment input root identity");
    asNonEmptyString(attemptId, "Experiment attempt identity");
    grant = await issueExperimentGrant(client, caller, "materialize", options.signal);
    const { scoped } = grant;
    const branch = await scoped.readBranch({ branchId: input.branchId }, options.signal);
    if (branch.workspaceId !== caller.workspaceId || branch.root !== input.root || branch.currentRoot !== input.root) {
      throw new Error("Experiment input branch no longer matches the persisted immutable root");
    }
    const handshake = client.handshake ?? await client.start();
    const storageRoot = await canonicalizePathIdentity(handshake.storageRoot);
    const { managedRoot, attemptRoot } = managedAttemptPath(storageRoot, caller.workspaceId, attemptId);
    const container = await scoped.fileRootRegister({
      workspaceId: caller.workspaceId,
      executionWorkspaceId: caller.executionWorkspaceId,
      canonicalRoot: storageRoot,
    }, options.signal);
    const containerRootId = container.rootId;
    const relativeTarget = path.relative(storageRoot, attemptRoot).replaceAll("\\", "/");
    if (!relativeTarget || relativeTarget.startsWith("../") || path.isAbsolute(relativeTarget)) {
      throw new Error("Experiment attempt directory escaped managed storage");
    }
    materializationDispatched = true;
    const materialized = await scoped.fileMaterialize({
      operationId: `experiment-attempt-materialize:${caller.workspaceId}:${attemptId}`,
      workspaceId: caller.workspaceId,
      rootId: containerRootId,
      path: relativeTarget,
      sourceRoot: input.root,
    }, options.signal);
    materializationDrained = true;
    if (materialized.status !== "materialized") {
      throw new Error(`Experiment attempt materialization was not completed: ${String(materialized.reason ?? "conflict")}`);
    }
    const canonicalTarget = await canonicalizePathIdentity(attemptRoot);
    assertInRoot(canonicalTarget, managedRoot, "Experiment materialized attempt");
    const target = await scoped.fileRootRegister({
      workspaceId: caller.workspaceId,
      executionWorkspaceId: caller.executionWorkspaceId,
      canonicalRoot: canonicalTarget,
    }, options.signal);
    const rootId = target.rootId;
    transferred = true;
    return {
      releaseAuthority: grant.release,
      attemptId,
      branchId: input.branchId,
      snapshotRoot: input.root,
      scoped,
      rootId,
      canonicalRoot: canonicalTarget,
      cwd: input.cwd ?? "",
      containerRootId,
      managedRoot,
      materialized: true,
    };
  }
  catch (error) {
    if (error instanceof KernelClientError && error.code === "cancelled")
      materializationDrained = true;
    throw new ExperimentPreparationError(error instanceof Error ? error.message : String(error), {
      drained: !materializationDispatched || materializationDrained || (error instanceof KernelClientError && error.code === "cancelled"),
      retryable: (materializationDispatched && !materializationDrained) || error instanceof KernelClientError,
      cause: error,
    });
  }
  finally {
    if (!transferred && (!materializationDispatched || materializationDrained))
      await grant?.release();
  }
}
/** Probe the original source lease after an interrupted input worker, without recapturing content. */
export async function reconcileExperimentCapture(client: KernelClient, caller: ExperimentWorkspaceCaller, sourceRoot: string, captureScopes: readonly string[]): Promise<"drained" | "unknown"> {
  if (await canonicalizePathIdentity(sourceRoot) !== sourceRoot)
    throw new Error("Experiment source identity changed");
  const grant = await issueExperimentGrant(client, caller, "prepare");
  const { scoped } = grant;
  try {
    const root = await scoped.fileRootRegister({ workspaceId: caller.workspaceId, executionWorkspaceId: caller.executionWorkspaceId, canonicalRoot: sourceRoot });
    const rootId = root.rootId;
    const leaseId = `experiment-input-observe:${randomUUID()}`;
    const lease = await scoped.fileLeaseAcquire({ workspaceId: caller.workspaceId, rootId, leaseId,
      resources: (captureScopes.length ? [...captureScopes] : [""]).map((entry) => ({ path: entry, scope: "subtree" })) });
    if (lease.status === "busy")
      return "unknown";
    if (lease.status !== "acquired")
      throw new Error("Experiment source lease returned no confirmed acquisition");
    try {
      return "drained";
    }
    finally {
      await scoped.fileLeaseRelease({ workspaceId: caller.workspaceId, rootId, leaseId });
    }
  }
  finally {
    await grant.release();
  }
}
/** Confirm the original local materialization has committed and its real physical writer lease has drained. */
export async function reconcileExperimentPreparation(client: KernelClient, caller: ExperimentWorkspaceCaller, attemptId: string, input: ExperimentInputSnapshot): Promise<"drained" | "unknown"> {
  assertCaller(caller);
  const grant = await issueExperimentGrant(client, caller, "materialize");
  const { scoped } = grant;
  try {
    const receipt = await scoped.getOperation(`experiment-attempt-materialize:${caller.workspaceId}:${attemptId}`);
    if (!receipt || receipt.state !== "committed" || !receipt.result || typeof receipt.result !== "object"
      || (receipt.result as Record<string, unknown>).root !== input.root)
      return "unknown";
    const handshake = client.handshake ?? await client.start();
    const storageRoot = await canonicalizePathIdentity(handshake.storageRoot);
    const { attemptRoot } = managedAttemptPath(storageRoot, caller.workspaceId, attemptId);
    const registered = await scoped.fileRootRegister({ workspaceId: caller.workspaceId,
      executionWorkspaceId: caller.executionWorkspaceId, canonicalRoot: storageRoot });
    const rootId = registered.rootId;
    const leaseId = `experiment-preparation-observe:${randomUUID()}`;
    const lease = await scoped.fileLeaseAcquire({ workspaceId: caller.workspaceId, rootId, leaseId,
      resources: [{ path: path.relative(storageRoot, attemptRoot).replaceAll("\\", "/"), scope: "subtree" }] });
    if (lease.status === "busy")
      return "unknown";
    if (lease.status !== "acquired")
      throw new Error("Experiment preparation lease returned no confirmed acquisition");
    try {
      return "drained";
    }
    finally {
      await scoped.fileLeaseRelease({ workspaceId: caller.workspaceId, rootId, leaseId });
    }
  }
  finally {
    await grant.release();
  }
}
/**
* Read an immutable experiment snapshot for a managed execution target. File
* bodies remain paged from the local Rust object store and are transferred only
* when the target reports that their content hash is absent.
*/
export async function openExperimentInputTransfer(client: KernelClient, caller: ExperimentWorkspaceCaller, input: ExperimentInputSnapshot, options: {
  signal?: AbortSignal;
} = {}): Promise<ExperimentInputTransfer> {
  assertCaller(caller);
  if (caller.workspaceId !== input.workspaceId || caller.executionWorkspaceId !== input.executionWorkspaceId) {
    throw new Error("Experiment transfer identity does not match the input snapshot");
  }
  const grant = await issueExperimentGrant(client, caller, "prepare", options.signal);
  const { scoped } = grant;
  try {
    const entries: Array<{
      path: string;
      state: KernelBranchState;
    }> = [];
    let cursor: number | undefined;
    do {
      const page = await scoped.readBranch({
        branchId: input.branchId,
        includeEntries: true,
        pageSize: 1024,
        ...(cursor === undefined ? {} : { cursor }),
      }, options.signal);
      if (page.workspaceId !== caller.workspaceId || page.root !== input.root || page.currentRoot !== input.root) {
        throw new Error("Experiment input branch no longer matches the persisted immutable root");
      }
      entries.push(...page.entries.map((entry) => ({ path: entry.path, state: entry.state })));
      cursor = page.nextCursor === null || page.nextCursor === undefined ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    const objectPaths = new Map<string, string>();
    for (const entry of entries) {
      if (entry.state.kind === "regular-file" && !objectPaths.has(entry.state.objectHash)) {
        objectPaths.set(entry.state.objectHash, entry.path);
      }
    }
    const readers = new Set<Promise<void>>();
    let closing = false;
    let closeWork: Promise<void> | undefined;
    return {
      close() {
        closing = true;
        return closeWork ??= Promise.all([...readers]).then(() => grant.release());
      },
      materialId: input.root,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      entries,
      readObject: (objectHash, byteLength, signal) => (async function* () {
        if (closing)
          throw new Error("Experiment input transfer is closed");
        let finish!: () => void;
        const reader = new Promise<void>(resolve => { finish = resolve; });
        readers.add(reader);
        try {
          const sourcePath = objectPaths.get(objectHash);
          if (!sourcePath)
            throw new Error(`Experiment snapshot does not contain object ${objectHash}`);
          let offset = 0;
          while (offset < byteLength) {
            signal?.throwIfAborted();
            const page = await scoped.getBlob(objectHash, { branchId: input.branchId, path: sourcePath }, { offset, length: Math.min(256 * 1024, byteLength - offset), ...(signal ? { signal } : {}) });
            const bytes = Buffer.from(page.bytesBase64, "base64");
            if (bytes.byteLength === 0 || page.nextOffset <= offset)
              throw new Error(`Experiment object ${objectHash} stopped at byte ${offset}`);
            offset = page.nextOffset;
            yield bytes;
          }
          if (offset !== byteLength)
            throw new Error(`Experiment object ${objectHash} length changed during transfer`);
        }
        finally {
          readers.delete(reader);
          finish();
        }
      })(),
    };
  }
  catch (error) {
    await grant.release();
    throw error;
  }
}

/** Decode source-owner facts once at the network boundary. Object bytes are verified by Storage. */
export function parseManagedExperimentInput(value: unknown): import('../kernel/managed-research-source.js').ManagedExperimentInput {
  const raw = value as import('../kernel/managed-research-source.js').ManagedExperimentInput;
  const snapshot = raw?.snapshot;
  if (!snapshot || snapshot.schemaVersion !== 2 || typeof snapshot.branchId !== 'string' || !snapshot.branchId
    || typeof snapshot.root !== 'string' || !/^sha256-[0-9a-f]{64}$/u.test(snapshot.root) || !snapshot.workspaceId || typeof snapshot.workspaceId !== 'string'
    || !snapshot.executionWorkspaceId || typeof snapshot.executionWorkspaceId !== 'string'
    || snapshot.sourceRoot !== null && typeof snapshot.sourceRoot !== 'string'
    || !Array.isArray(snapshot.captureScopes) || !snapshot.captureScopes.every(scope => typeof scope === 'string')
    || snapshot.capturedPathCount !== null && (!Number.isSafeInteger(snapshot.capturedPathCount) || snapshot.capturedPathCount < 0)
    || snapshot.inventoryFingerprint !== null && typeof snapshot.inventoryFingerprint !== 'string'
    || snapshot.cwd !== undefined && typeof snapshot.cwd !== 'string' || !Array.isArray(raw.entries)) throw new Error('Managed experiment input is unconfirmed');
  if (snapshot.source?.kind !== 'physical-capture' && (snapshot.source?.kind !== 'fixed-branch'
    || !snapshot.source.branchId || typeof snapshot.source.branchId !== 'string' || !Number.isSafeInteger(snapshot.source.revision) || snapshot.source.revision < 0
    || typeof snapshot.source.root !== 'string' || !/^sha256-[0-9a-f]{64}$/u.test(snapshot.source.root))) throw new Error('Managed experiment input origin is unconfirmed');
  if (snapshot.captureSemantics !== null && (!snapshot.captureSemantics
    || !isDeepStrictEqual(snapshot.captureSemantics.excludedDirectories, CAPTURE_EXCLUDED_DIRECTORIES)
    || snapshot.captureSemantics.gitignore !== 'not-applied' || snapshot.captureSemantics.ignoredFilesIncluded !== true))
    throw new Error('Managed experiment input capture semantics are unconfirmed');
  snapshot.captureScopes.forEach(scope => normalizeRelative(scope, 'Experiment capture scope'));
  if (snapshot.cwd !== undefined) normalizeRelative(snapshot.cwd, 'Experiment cwd');
  const names = new Set<string>();
  const entries = raw.entries.map(entry => {
    const name = normalizeRelative(entry?.path, 'Experiment input path');
    if (names.has(name)) throw new Error('Managed experiment input has duplicate paths');
    names.add(name);
    return { path: name, state: parseState(entry.state, name) };
  });
  return { snapshot, entries };
}

/** Install the original source's stream into this Storage before publishing an input branch. */
export async function installExperimentInput(client: KernelClient, caller: ExperimentWorkspaceCaller,
  input: import('../kernel/managed-research-source.js').ManagedExperimentInput,
  source: LaunchSource, resourceEpoch: string,
  read: (name: string, offset: number, length: number, signal?: AbortSignal) => Promise<KernelObjectSlice>,
  options: PrepareExperimentInputOptions,
): Promise<ExperimentInputSnapshot> {
  if (!options.branchId || input.snapshot.workspaceId !== caller.workspaceId || input.snapshot.executionWorkspaceId !== caller.executionWorkspaceId)
    throw new ExperimentInputCaptureError('Managed experiment input attribution changed', false, { drained: true, retryable: false, cause: undefined });
  if (input.snapshot.source.kind === 'managed-source') throw new Error('Experiment input must come from its original source owner');
  const grant = await issueExperimentGrant(client, caller, 'prepare', options.signal);
  const owners = new Map<string, string>();
  let dispatched = false;
  let outcome: { snapshot: ExperimentInputSnapshot } | { error: unknown };
  try {
    const candidate: ExperimentInputCapture = { schemaVersion: 2, branchId: options.branchId, sourceRoot: null,
      workspaceId: caller.workspaceId, executionWorkspaceId: caller.executionWorkspaceId,
      captureScopes: [...input.snapshot.captureScopes], capturedPathCount: input.snapshot.capturedPathCount,
      inventoryFingerprint: input.snapshot.inventoryFingerprint, captureSemantics: input.snapshot.captureSemantics,
      ...(input.snapshot.cwd ? { cwd: input.snapshot.cwd } : {}),
      source: { kind: 'managed-source', selection: source, origin: input.snapshot.source,
        sourceBranchId: input.snapshot.branchId, resourceEpoch } };
    // The remote root is provenance until local Storage verifies and owns every referenced byte.
    for (const entry of input.entries) {
      if (entry.state.kind !== 'regular-file' || owners.has(entry.state.objectHash)) continue;
      const state = entry.state;
      const chunks = (async function* () {
        let offset = 0;
        while (offset < state.byteLength) {
          options.signal?.throwIfAborted();
          const page = await read(entry.path, offset, Math.min(256 * 1024, state.byteLength - offset), options.signal);
          const bytes = Buffer.from(page.bytesBase64, 'base64');
          if (page.hash !== state.objectHash || page.offset !== offset || page.byteLength !== state.byteLength || page.nextOffset !== offset + bytes.length || !bytes.length
            || page.nextOffset > state.byteLength || page.eof !== (page.nextOffset === state.byteLength)) throw new Error('Managed experiment input page changed');
          offset = page.nextOffset;
          yield bytes;
        }
      })();
      const blob = await grant.scoped.putBlobStream(chunks, { operationId: `experiment-input-object:${randomUUID()}`,
        byteLength: state.byteLength, expectedHash: state.objectHash }, options.signal);
      if (blob.hash !== state.objectHash || blob.byteLength !== state.byteLength) throw new Error('Installed experiment object differs from its source');
      owners.set(state.objectHash, blob.ownerId);
    }
    await options.beforeBranchCreate?.(candidate);
    options.signal?.throwIfAborted();
    dispatched = true;
    const created = await grant.scoped.createBranch({ operationId: `experiment-input-branch:${candidate.branchId}`, branchId: candidate.branchId,
      workspaceId: caller.workspaceId, entries: input.entries.map(entry => ({ ...entry,
        ...(entry.state.kind === 'regular-file' ? { ownerId: owners.get(entry.state.objectHash)! } : {}) })),
      draftBasePaths: [], captureScopes: candidate.captureScopes });
    if (created.root !== input.snapshot.root || created.branchId !== candidate.branchId) throw new Error('Installed experiment input root differs from its source');
    const branch = await grant.scoped.readBranch({ branchId: candidate.branchId, includeEntries: false });
    if (branch.workspaceId !== caller.workspaceId || branch.root !== created.root || branch.currentRoot !== created.root) throw new Error('Installed experiment input branch changed');
    outcome = { snapshot: { ...candidate, root: input.snapshot.root } };
  } catch (error) {
    outcome = { error };
  }
  try {
    // Native retirement discards this grant's upload streams and temporary
    // object owners together. Committed branches retain their own roots.
    await grant.release();
  } catch (cleanup) {
    // The transfer loop and its remote reader have ended. Local uploads and
    // branch commits are joined Storage metadata requests, not retained file
    // workers. Keep a lost cleanup ACK retryable, without inventing a live reader.
    throw new ExperimentInputCaptureError('Experiment input transfer cleanup is unconfirmed', dispatched,
      { drained: true, retryable: true, cause: 'error' in outcome ? new AggregateError([outcome.error, cleanup]) : cleanup });
  }
  if ('error' in outcome) throw new ExperimentInputCaptureError(outcome.error instanceof Error ? outcome.error.message : String(outcome.error), dispatched,
    { drained: true, retryable: dispatched || outcome.error instanceof KernelClientError, cause: outcome.error });
  return outcome.snapshot;
}

export const experimentManagedDirectoryName = MANAGED_EXPERIMENTS_DIRECTORY;
