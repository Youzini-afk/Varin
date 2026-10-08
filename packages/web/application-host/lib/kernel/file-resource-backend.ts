import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { waitWithSignal } from "../cancellation.js";
import type {
  CapturedState,
  CaptureStateOptions,
  RecoveryFileStore,
  RecoveryIdentity,
  RecoveryState,
  ResolvedPath,
} from "../recovery/journal-files.js";
import { createRecoveryFileReader, normalizeResourceId, parseRecoveryState } from "../recovery/journal-files.js";
import type { HostResourceOperation, HostResourceOperationGate } from "../recovery/durable-file-operation.js";
import { canonicalizePathIdentity } from "../workspace/path-safety.js";
import type { KernelFileAuthorityContext, KernelStorageAdapter } from "./storage-adapter.js";

export interface KernelExecutionRoot {
  workspaceId: string;
  canonicalRoot: string;
}

export interface KernelFileResourceBackendOptions {
  resolveExecutionRoot?: (canonicalRoot: string, owningWorkspaceId: string) => Promise<KernelExecutionRoot>;
  authorityPurpose?: string;
  authorityCapabilities?: string[];
  busyRetryMs?: number;
}

interface BoundFileContext extends KernelFileAuthorityContext {
  basePath: string;
}

interface LeaseContext {
  key: string;
  leaseId: string;
  observed: Map<string, RecoveryState>;
}

const normalizeRelative = (value: string): string => {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized === ".") return "";
  return normalizeResourceId(normalized);
};

const sameFsPath = (left: string, right: string): boolean => {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
};

const relativeInside = (root: string, target: string): string => {
  const relative = path.relative(root, target);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`Kernel file root is outside the Documents execution workspace: ${target}`);
  }
  return normalizeRelative(relative);
};

const joinResource = (basePath: string, resourceId: string): string => {
  const relative = normalizeRelative(resourceId);
  return basePath ? (relative ? `${basePath}/${relative}` : basePath) : relative;
};

const parseCaptured = (value: Record<string, unknown>): CapturedState => {
  if (typeof value.path !== "string" || typeof value.stateJson !== "string") {
    throw new Error("Kernel returned an invalid file capture result");
  }
  return { path: value.path, state: parseRecoveryState(JSON.parse(value.stateJson)) };
};

export class KernelFileResourceBackend implements RecoveryFileStore {
  private readonly helper = createRecoveryFileReader();
  private readonly leaseContext = new AsyncLocalStorage<LeaseContext>();
  private readonly busyRetryMs: number;

  constructor(
    private readonly adapter: KernelStorageAdapter,
    private readonly options: KernelFileResourceBackendOptions = {},
  ) {
    this.busyRetryMs = options.busyRetryMs ?? 5;
  }

  private async bind(identity: RecoveryIdentity): Promise<BoundFileContext> {
    const execution = this.options.resolveExecutionRoot
      ? await this.options.resolveExecutionRoot(identity.canonicalRoot, identity.workspaceId)
      : { workspaceId: identity.workspaceId, canonicalRoot: identity.canonicalRoot };
    // Documents and a caller may name the same Windows directory through
    // long and 8.3 forms. Resolve both through the filesystem before the
    // containment check; this also prevents a symlink/reparse alias from
    // turning a lexical child into an authority escape.
    const canonicalRoot = await canonicalizePathIdentity(execution.canonicalRoot);
    const requestedRoot = await canonicalizePathIdentity(identity.canonicalRoot, { allowMissing: true });
    const basePath = sameFsPath(canonicalRoot, requestedRoot) ? "" : relativeInside(canonicalRoot, requestedRoot);
    const authority = await this.adapter.fileAuthorityContext({
      owningWorkspaceId: identity.workspaceId,
      executionWorkspaceId: execution.workspaceId,
      canonicalRoot,
      ...(this.options.authorityPurpose ? { purpose: this.options.authorityPurpose } : {}),
      ...(this.options.authorityCapabilities ? { capabilities: this.options.authorityCapabilities } : {}),
    });
    return { ...authority, basePath };
  }

  private leaseFor(context: BoundFileContext): LeaseContext | undefined {
    const current = this.leaseContext.getStore();
    if (!current) return undefined;
    return current.key === `${context.owningWorkspaceId}\0${context.rootId}` ? current : undefined;
  }

  private translated(context: BoundFileContext, resourceId: string): string {
    return joinResource(context.basePath, resourceId);
  }

  private async acquire(
    context: BoundFileContext,
    resources: readonly HostResourceOperation[],
    signal?: AbortSignal,
  ): Promise<string> {
    const leaseId = `file-lease:${randomUUID()}`;
    const translated = resources.map((resource) => ({
      path: this.translated(context, resource.resourceId),
      scope: resource.scope,
    }));
    for (;;) {
      signal?.throwIfAborted();
      // Receive the acquire result even if cancellation races it. Otherwise
      // an acquired native lease could outlive its caller without a receipt.
      const result = await context.client.fileLeaseAcquire({
        workspaceId: context.owningWorkspaceId,
        rootId: context.rootId,
        leaseId,
        resources: translated,
      });
      if (result.status === "acquired") return leaseId;
      if (result.status !== "busy") throw new Error("Kernel returned an invalid file lease result");
      await delay(this.busyRetryMs, undefined, { signal });
    }
  }

  gateFor(identity: RecoveryIdentity): HostResourceOperationGate {
    return {
      run: async <Result>(resources: readonly HostResourceOperation[], operation: () => Promise<Result>, options: { signal?: AbortSignal } = {}): Promise<Result> => {
        options.signal?.throwIfAborted();
        if (resources.length === 0) return operation();
        const context = await waitWithSignal(this.bind(identity), options.signal);
        const existing = this.leaseFor(context);
        if (existing) {
          await context.client.fileLeaseCheck({
            workspaceId: context.owningWorkspaceId,
            rootId: context.rootId,
            leaseId: existing.leaseId,
            resources: resources.map((resource) => ({
              path: this.translated(context, resource.resourceId), scope: resource.scope,
            })),
          });
          options.signal?.throwIfAborted();
          return operation();
        }
        if (this.leaseContext.getStore()) {
          throw new Error("Nested file operation cannot rebind its active resource lease to another root");
        }
        const leaseId = await this.acquire(context, resources, options.signal);
        const lease: LeaseContext = {
          key: `${context.owningWorkspaceId}\0${context.rootId}`,
          leaseId,
          observed: new Map(),
        };
        try {
          options.signal?.throwIfAborted();
          return await this.leaseContext.run(lease, operation);
        } finally {
          await context.client.fileLeaseRelease({
            workspaceId: context.owningWorkspaceId,
            rootId: context.rootId,
            leaseId,
          }).catch(() => undefined);
        }
      },
    };
  }

  async captureDetailed(
    identity: RecoveryIdentity,
    inputPath: string,
    options: CaptureStateOptions = {},
    operationId = `file-capture:${randomUUID()}`,
  ): Promise<CapturedState & { ownerId?: string }> {
    const resolved = await this.relativePathFor(identity, inputPath);
    const context = await this.bind(identity);
    const relative = this.translated(context, resolved.relative);
    const lease = this.leaseFor(context);
    if (!lease) {
      return this.gateFor(identity).run([{ resourceId: resolved.relative, scope: "exact" }],
        () => this.captureDetailed(identity, inputPath, options, operationId));
    }
    const value = await context.client.fileCapture({
      operationId,
      workspaceId: context.owningWorkspaceId,
      rootId: context.rootId,
      path: relative,
      store: options.store !== false,
      leaseId: lease.leaseId,
    });
    const captured = parseCaptured(value);
    const result: CapturedState & { ownerId?: string } = {
      path: resolved.relative,
      state: captured.state,
      ...(typeof value.ownerId === "string" ? { ownerId: value.ownerId } : {}),
    };
    lease.observed.set(relative, result.state);
    return result;
  }

  async captureState(
    identity: RecoveryIdentity,
    _root: string,
    inputPath: string,
    options: CaptureStateOptions = {},
  ): Promise<CapturedState> {
    return this.captureDetailed(identity, inputPath, options);
  }

  async applyState(
    identity: RecoveryIdentity,
    _root: string,
    relativePath: string,
    state: RecoveryState,
  ): Promise<void> {
    const applied = await this.applyStateDetailed(identity, relativePath, state);
    if (applied.status === "conflict") {
      throw new Error(`Kernel file apply conflict: ${relativePath}`);
    }
  }

  async applyStateDetailed(
    identity: RecoveryIdentity,
    relativePath: string,
    state: RecoveryState,
    options: { expected?: RecoveryState; ownerId?: string; operationId?: string } = {},
  ): Promise<{ status: "applied" | "conflict"; state: RecoveryState }> {
    const resolved = await this.relativePathFor(identity, relativePath);
    const context = await this.bind(identity);
    const pathId = this.translated(context, resolved.relative);
    const lease = this.leaseFor(context);
    const expected = options.expected ?? lease?.observed.get(pathId);
    const value = await context.client.fileApply({
      operationId: options.operationId ?? `file-apply:${randomUUID()}`,
      workspaceId: context.owningWorkspaceId,
      rootId: context.rootId,
      path: pathId,
      targetJson: JSON.stringify(state),
      ...(expected ? { expectedJson: JSON.stringify(expected) } : {}),
      ...(options.ownerId ? { ownerId: options.ownerId } : {}),
      ...(lease ? { leaseId: lease.leaseId } : {}),
    });
    if ((value.status !== "applied" && value.status !== "conflict") || typeof value.stateJson !== "string") {
      throw new Error("Kernel returned an invalid file apply result");
    }
    const observed = parseRecoveryState(JSON.parse(value.stateJson));
    lease?.observed.set(pathId, observed);
    return { status: value.status, state: observed };
  }

  async writeBytes(
    identity: RecoveryIdentity,
    relativePath: string,
    bytes: Uint8Array,
    options: { expected?: RecoveryState; mode?: number; operationId?: string } = {},
  ): Promise<{ status: "applied" | "conflict"; state: RecoveryState }> {
    const context = await this.bind(identity);
    const stored = await context.client.putBlob(bytes, `file-write-object:${randomUUID()}`);
    const target: RecoveryState = {
      kind: "regular-file",
      objectHash: stored.hash,
      byteLength: stored.byteLength,
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    };
    return this.applyStateDetailed(identity, relativePath, target, {
      ...(options.expected ? { expected: options.expected } : {}),
      ownerId: stored.ownerId,
      operationId: options.operationId ?? `file-write:${randomUUID()}`,
    });
  }

  async mkdir(identity: RecoveryIdentity, relativePath: string, recursive = true): Promise<void> {
    const context = await this.bind(identity);
    const pathId = this.translated(context, normalizeRelative(relativePath));
    const lease = this.leaseFor(context);
    const value = await context.client.fileMkdir({
      operationId: `file-mkdir:${randomUUID()}`,
      workspaceId: context.owningWorkspaceId,
      rootId: context.rootId,
      path: pathId,
      recursive,
      ...(lease ? { leaseId: lease.leaseId } : {}),
    });
    if (value.status !== "created") throw new Error("Kernel failed to create workspace directory");
  }

  async remove(identity: RecoveryIdentity, relativePath: string, options: { recursive?: boolean; force?: boolean; operationId?: string } = {}): Promise<void> {
    const context = await this.bind(identity);
    const pathId = this.translated(context, normalizeRelative(relativePath));
    const lease = this.leaseFor(context);
    const value = await context.client.fileRemove({
      operationId: options.operationId ?? `file-remove:${randomUUID()}`,
      workspaceId: context.owningWorkspaceId,
      rootId: context.rootId,
      path: pathId,
      recursive: options.recursive ?? false,
      force: options.force ?? false,
      ...(lease ? { leaseId: lease.leaseId } : {}),
    });
    if (value.status !== "removed") throw new Error("Kernel failed to remove workspace resource");
  }

  async rename(
    identity: RecoveryIdentity,
    fromPath: string,
    toPath: string,
    options: {
      targetMustBeMissing?: boolean;
      expectedFrom?: RecoveryState;
      expectedTo?: RecoveryState;
      operationId?: string;
    } = {},
  ): Promise<"renamed" | "target-exists" | "conflict"> {
    const context = await this.bind(identity);
    const lease = this.leaseFor(context);
    const value = await context.client.fileRename({
      operationId: options.operationId ?? `file-rename:${randomUUID()}`,
      workspaceId: context.owningWorkspaceId,
      rootId: context.rootId,
      fromPath: this.translated(context, normalizeRelative(fromPath)),
      toPath: this.translated(context, normalizeRelative(toPath)),
      ...(options.targetMustBeMissing === undefined ? {} : { targetMustBeMissing: options.targetMustBeMissing }),
      ...(options.expectedFrom ? { expectedFromJson: JSON.stringify(options.expectedFrom) } : {}),
      ...(options.expectedTo ? { expectedToJson: JSON.stringify(options.expectedTo) } : {}),
      ...(lease ? { leaseId: lease.leaseId } : {}),
    });
    if (value.status !== "renamed" && value.status !== "target-exists" && value.status !== "conflict") {
      throw new Error("Kernel returned an invalid file rename result");
    }
    return value.status;
  }

  async scanPaths(
    identity: RecoveryIdentity,
    relativePath = "",
    scopes?: readonly string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<string[]> {
    const context = await this.bind(identity);
    const output: string[] = [];
    let cursor: number | undefined;
    let expectedFingerprint: string | undefined;
    do {
      const value = await context.client.fileScan({
        workspaceId: context.owningWorkspaceId,
        rootId: context.rootId,
        path: this.translated(context, normalizeRelative(relativePath)),
        ...(scopes && scopes.length > 0 ? { scopes: scopes.map(normalizeRelative) } : {}),
        ...(cursor === undefined ? {} : { cursor }),
        pageSize: 1024,
        ...(expectedFingerprint === undefined ? {} : { expectedFingerprint }),
      }, options.signal);
      const page = Array.isArray(value.paths) && value.paths.every((entry) => typeof entry === "string")
        ? value.paths as string[]
        : null;
      if (!page) throw new Error("Kernel returned an invalid file scan page");
      output.push(...page.map(normalizeRelative));
      if (typeof value.fingerprint !== "string") throw new Error("Kernel scan returned no inventory identity");
      expectedFingerprint = value.fingerprint;
      cursor = typeof value.nextCursor === "number" ? value.nextCursor : undefined;
    } while (cursor !== undefined);
    return [...new Set(output)].sort();
  }

  async measure(
    identity: RecoveryIdentity,
    relativePath = "",
    options: { signal?: AbortSignal } = {},
  ): Promise<{ logicalBytes: number | null; allocatedBytes: number | null; unknown: boolean }> {
    const context = await this.bind(identity);
    const value = await context.client.fileMeasure({
      workspaceId: context.owningWorkspaceId,
      rootId: context.rootId,
      path: this.translated(context, normalizeRelative(relativePath)),
    }, options.signal);
    const logicalBytes = value.logicalBytes === null || value.logicalBytes === undefined
      ? null
      : Number(value.logicalBytes);
    const allocatedBytes = value.allocatedBytes === null || value.allocatedBytes === undefined
      ? null
      : Number(value.allocatedBytes);
    if ((logicalBytes !== null && (!Number.isSafeInteger(logicalBytes) || logicalBytes < 0))
      || (allocatedBytes !== null && (!Number.isSafeInteger(allocatedBytes) || allocatedBytes < 0))) {
      throw new Error("Kernel returned an invalid file measurement");
    }
    return {
      logicalBytes,
      allocatedBytes,
      unknown: value.unknown === true,
    };
  }

  async materializeRoot(
    identity: RecoveryIdentity,
    relativePath: string,
    sourceRoot: string,
    options: { operationId: string; signal?: AbortSignal },
  ): Promise<{
    status: "materialized" | "conflict";
    reconciled: boolean;
    cow: { reflink: number; copy: number };
  }> {
    const context = await this.bind(identity);
    const existing = this.leaseFor(context);
    if (!existing) {
      return this.gateFor(identity).run(
        [{ resourceId: relativePath, scope: "subtree" }],
        () => this.materializeRoot(identity, relativePath, sourceRoot, options),
      );
    }
    const value = await context.client.fileMaterialize({
      operationId: options.operationId,
      workspaceId: context.owningWorkspaceId,
      rootId: context.rootId,
      path: this.translated(context, normalizeRelative(relativePath)),
      sourceRoot,
      leaseId: existing.leaseId,
    }, options.signal);
    if (value.status !== "materialized" && value.status !== "conflict") {
      throw new Error("Kernel returned an invalid materialization result");
    }
    const cow = value.cow && typeof value.cow === "object" ? value.cow as Record<string, unknown> : {};
    return {
      status: value.status,
      reconciled: value.reconciled === true,
      cow: {
        reflink: typeof cow.reflink === "number" ? cow.reflink : 0,
        copy: typeof cow.copy === "number" ? cow.copy : 0,
      },
    };
  }

  hashFile(filePath: string) {
    return this.helper.hashFile(filePath);
  }

  async relativePathFor(identity: RecoveryIdentity, inputPath: string): Promise<ResolvedPath> {
    return this.helper.relativePathFor(identity, inputPath);
  }

  async verifyObject(_root: string, state: RecoveryState): Promise<void> {
    if (state.kind !== "regular-file") return;
    // Kernel object identity is revalidated when a state is applied or read.
  }
}
