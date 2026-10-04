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
import type { KernelBranchState } from "../kernel/protocol.generated.js";
import type { KernelClient, KernelScopedClient } from "../kernel/kernel-client.js";
import { canonicalizePathIdentity, isPathWithinRoot } from "../workspace/path-safety.js";

const MANAGED_EXPERIMENTS_DIRECTORY = path.join("managed", "experiments");
const CAPTURE_EXCLUDED_DIRECTORIES = [".git", ".varin"] as const;

export interface ExperimentWorkspaceCaller {
  /** Workspace that owns the durable experiment/spec facts and source branch. */
  workspaceId: string;
  /** Explicit execution identity. It is never inferred from workspaceId. */
  executionWorkspaceId: string;
  sessionId?: string;
  threadId?: string;
  runId?: string;
}

export interface PrepareExperimentInputOptions {
  /** Relative source directories/files explicitly admitted by the caller. `[]` means the root. */
  captureScopes?: readonly string[];
  /** Working directory relative to the captured source root. */
  cwd?: string;
  signal?: AbortSignal;
}

export interface ExperimentInputSnapshot {
  schemaVersion: 1;
  branchId: string;
  /** Immutable root returned by branch creation. This is the durable spec input. */
  root: string;
  sourceRoot: string;
  workspaceId: string;
  executionWorkspaceId: string;
  captureScopes: string[];
  capturedPathCount: number;
  inventoryFingerprint: string;
  /** The source file authority does not apply Git ignore rules. */
  captureSemantics: {
    excludedDirectories: readonly [".git", ".varin"];
    gitignore: "not-applied";
    ignoredFilesIncluded: true;
  };
  cwd?: string;
}

export interface MaterializedExperimentAttempt {
  attemptId: string;
  branchId: string;
  /** Immutable branch root used as the materialization source. */
  snapshotRoot: string;
  /** Ephemeral execution grant; do not persist it with the spec/attempt record. */
  scoped: KernelScopedClient;
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
): Promise<KernelScopedClient> => {
  assertCaller(caller);
  signal?.throwIfAborted();
  await client.start();
  const grant = await client.issueGrant({
    grantId: `experiment-workspace:${purpose}:${randomUUID()}`,
    owningWorkspace: caller.workspaceId,
    executionWorkspace: caller.executionWorkspaceId,
    sessionId: caller.sessionId,
    threadId: caller.threadId,
    runId: caller.runId,
    capabilities: purpose === "materialize"
      ? ["storage.read", "storage.write", "recovery", "recovery.maintenance", "process", "process.maintenance"]
      : ["storage.read", "storage.write"],
    // The root registration is the authority boundary. Materialization also
    // requires an unbounded source-view grant, hence the explicit empty scope.
    pathScopes: [""],
  }, signal);
  return client.scoped(grant);
};

const scanInventory = async (
  scoped: KernelScopedClient,
  workspaceId: string,
  rootId: string,
  scopes: readonly string[],
  signal?: AbortSignal,
): Promise<{ paths: string[]; fingerprint: string }> => {
  const paths: string[] = [];
  let cursor: number | undefined;
  let fingerprint: string | undefined;
  do {
    signal?.throwIfAborted();
    const page = await scoped.fileScan({
      workspaceId,
      rootId,
      path: "",
      pageSize: 1024,
      ...(scopes.length > 0 ? { scopes: [...scopes] } : {}),
      ...(cursor === undefined ? {} : { cursor }),
      ...(fingerprint === undefined ? {} : { expectedFingerprint: fingerprint }),
    }, signal);
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

const rootIdFrom = (value: Record<string, unknown>, label: string): string => {
  if (typeof value.rootId !== "string" || value.rootId.length === 0) throw new Error(`${label} returned no root identity`);
  return value.rootId;
};

/** Capture code/data into a durable immutable branch/root for an experiment spec. */
export async function prepareExperimentInput(
  client: KernelClient,
  caller: ExperimentWorkspaceCaller,
  canonicalRoot: string,
  options: PrepareExperimentInputOptions = {},
): Promise<ExperimentInputSnapshot> {
  assertCaller(caller);
  options.signal?.throwIfAborted();
  const sourceRoot = await canonicalizePathIdentity(asNonEmptyString(canonicalRoot, "Experiment source root"));
  if (!options.captureScopes) throw new Error("Experiment capture scopes must be explicit caller-authorized paths");
  const scopes = [...new Set(options.captureScopes.map((entry) => normalizeRelative(entry, "Experiment capture scope")))].sort();
  for (const scope of scopes) await validateScope(sourceRoot, scope);
  const cwd = options.cwd === undefined ? undefined : normalizeRelative(options.cwd, "Experiment cwd");
  const scoped = await issueExperimentGrant(client, caller, "prepare", options.signal);
  const registered = await scoped.fileRootRegister({
    workspaceId: caller.workspaceId,
    executionWorkspaceId: caller.executionWorkspaceId,
    canonicalRoot: sourceRoot,
  }, options.signal);
  const sourceRootId = rootIdFrom(registered, "Source file root registration");
  const inventory = await scanInventory(scoped, caller.workspaceId, sourceRootId, scopes, options.signal);
  if (cwd !== undefined) await validateCwd(sourceRoot, cwd, inventory.paths);

  const entries: CapturedEntry[] = [];
  let createdBranchId: string | undefined;
  try {
    for (const relative of inventory.paths) {
      options.signal?.throwIfAborted();
      const value = await scoped.fileCapture({
        operationId: `experiment-input-capture:${randomUUID()}`,
        workspaceId: caller.workspaceId,
        rootId: sourceRootId,
        path: relative,
        store: true,
      }, options.signal);
      const captured = captureState(value, relative);
      const snapshotState = await symlinkStateForSnapshot(sourceRoot, relative, captured.state, inventory.paths);
      entries.push({ ...captured, state: snapshotState, sourceState: captured.state });
    }

    // The list fingerprint protects scan pagination, while this fresh scan
    // catches additions/removals during the capture window.
    const afterInventory = await scanInventory(scoped, caller.workspaceId, sourceRootId, scopes, options.signal);
    if (afterInventory.fingerprint !== inventory.fingerprint
      || afterInventory.paths.length !== inventory.paths.length
      || afterInventory.paths.some((entry, index) => entry !== inventory.paths[index])) {
      throw new Error("Experiment source changed while its input snapshot was being captured");
    }

    // A path inventory does not include file bytes. Re-observe every captured
    // path so a multi-file snapshot cannot silently mix two live generations.
    for (const entry of entries) {
      options.signal?.throwIfAborted();
      const observed = await scoped.fileCapture({
        operationId: `experiment-input-verify:${randomUUID()}`,
        workspaceId: caller.workspaceId,
        rootId: sourceRootId,
        path: entry.path,
        store: false,
      }, options.signal);
      const verified = captureState(observed, entry.path, false);
      if (stableState(verified.state) !== stableState(entry.sourceState)) {
        throw new Error(`Experiment source changed while capturing: ${entry.path}`);
      }
      await symlinkStateForSnapshot(sourceRoot, entry.path, verified.state, inventory.paths);
    }

    const branchId = `experiment-input-${randomUUID()}`;
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
    }, options.signal);
    if (created.created === true) createdBranchId = branchId;
    const root = typeof created.root === "string" ? created.root : "";
    if (!root || created.branchId !== branchId) throw new Error("Kernel returned an invalid experiment input branch");
    const branch = await scoped.readBranch({ branchId }, options.signal);
    if (branch.workspaceId !== caller.workspaceId || branch.root !== root || branch.currentRoot !== root) {
      throw new Error("Experiment input branch changed while it was being created");
    }
    return {
      schemaVersion: 1,
      branchId,
      root,
      sourceRoot,
      workspaceId: caller.workspaceId,
      executionWorkspaceId: caller.executionWorkspaceId,
      captureScopes: scopes,
      capturedPathCount: inventory.paths.length,
      inventoryFingerprint: inventory.fingerprint,
      captureSemantics: {
        excludedDirectories: CAPTURE_EXCLUDED_DIRECTORIES,
        gitignore: "not-applied",
        ignoredFilesIncluded: true,
      },
      ...(cwd ? { cwd } : {}),
    };
  } catch (error) {
    // If branch creation succeeded but the post-create provenance check failed,
    // remove only the branch allocated by this call before releasing any
    // remaining temporary owners. A `created:false` response is never deleted.
    if (createdBranchId) {
      await scoped.deleteBranch({
        operationId: `experiment-input-branch-cleanup:${createdBranchId}:${randomUUID()}`,
        branchId: createdBranchId,
      }).catch(() => undefined);
    }
    await releaseOwners(scoped, entries.flatMap((entry) => entry.ownerId ? [entry.ownerId] : []));
    throw error;
  }
}

/** Materialize one independent attempt directory from the spec's immutable root. */
export async function materializeExperimentAttempt(
  client: KernelClient,
  caller: ExperimentWorkspaceCaller,
  attemptId: string,
  input: ExperimentInputSnapshot,
  options: { signal?: AbortSignal } = {},
): Promise<MaterializedExperimentAttempt> {
  assertCaller(caller);
  if (caller.workspaceId !== input.workspaceId || caller.executionWorkspaceId !== input.executionWorkspaceId) {
    throw new Error("Experiment execution identity does not match the input snapshot");
  }
  asNonEmptyString(input.branchId, "Experiment input branch identity");
  asNonEmptyString(input.root, "Experiment input root identity");
  asNonEmptyString(attemptId, "Experiment attempt identity");
  const scoped = await issueExperimentGrant(client, caller, "materialize");
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
  const containerRootId = rootIdFrom(container, "Experiment managed storage root registration");
  const relativeTarget = path.relative(storageRoot, attemptRoot).replaceAll("\\", "/");
  if (!relativeTarget || relativeTarget.startsWith("../") || path.isAbsolute(relativeTarget)) {
    throw new Error("Experiment attempt directory escaped managed storage");
  }
  const materialized = await scoped.fileMaterialize({
    operationId: `experiment-attempt-materialize:${caller.workspaceId}:${attemptId}`,
    workspaceId: caller.workspaceId,
    rootId: containerRootId,
    path: relativeTarget,
    sourceRoot: input.root,
  }, options.signal);
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
  const rootId = rootIdFrom(target, "Experiment attempt root registration");
  return {
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

/**
 * Read an immutable experiment snapshot for a managed execution target. File
 * bodies remain paged from the local Rust object store and are transferred only
 * when the target reports that their content hash is absent.
 */
export async function openExperimentInputTransfer(
  client: KernelClient,
  caller: ExperimentWorkspaceCaller,
  input: ExperimentInputSnapshot,
  options: { signal?: AbortSignal } = {},
): Promise<ExperimentInputTransfer> {
  assertCaller(caller);
  if (caller.workspaceId !== input.workspaceId || caller.executionWorkspaceId !== input.executionWorkspaceId) {
    throw new Error("Experiment transfer identity does not match the input snapshot");
  }
  const scoped = await issueExperimentGrant(client, caller, "prepare");
  const entries: Array<{ path: string; state: KernelBranchState }> = [];
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
  return {
    materialId: input.root,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    entries,
    readObject: (objectHash, byteLength, signal) => (async function* () {
      const sourcePath = objectPaths.get(objectHash);
      if (!sourcePath) throw new Error(`Experiment snapshot does not contain object ${objectHash}`);
      let offset = 0;
      while (offset < byteLength) {
        signal?.throwIfAborted();
        const page = await scoped.getBlob(
          objectHash,
          { branchId: input.branchId, path: sourcePath },
          { offset, length: Math.min(256 * 1024, byteLength - offset), ...(signal ? { signal } : {}) },
        );
        const bytes = Buffer.from(page.bytesBase64, "base64");
        if (bytes.byteLength === 0 || page.nextOffset <= offset) throw new Error(`Experiment object ${objectHash} stopped at byte ${offset}`);
        offset = page.nextOffset;
        yield bytes;
      }
      if (offset !== byteLength) throw new Error(`Experiment object ${objectHash} length changed during transfer`);
    })(),
  };
}

export const experimentManagedDirectoryName = MANAGED_EXPERIMENTS_DIRECTORY;
