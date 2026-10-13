import { randomUUID } from "node:crypto";
import type { PathLockResource, PathLockService } from "../harness/path-lock.js";
import { KernelClientError, type KernelScopedClient } from "./kernel-client.js";
import type { KernelStorageAdapter } from "./storage-adapter.js";

interface KernelLockBinding {
  ownerId: string;
  workspaceId: string;
  rootId: string;
  client: KernelScopedClient;
}

export interface KernelPathLockServiceOptions {
  resolveOwningWorkspaceId(ownerId: string, executionWorkspaceId: string): Promise<string>;
  resolveWorkspaceRoot(workspaceId: string): Promise<string>;
}

const normalizedResourceId = (resource: PathLockResource): string => {
  const candidate = resource.resourceId?.replace(/\\/g, "/").replace(/^\.\//, "");
  if (candidate !== undefined) return candidate;
  throw new Error("Kernel path lock requires a Documents-authorized relative resource id");
};

/**
 * Production fs.lock implementation. The local map owns only opaque lease
 * receipts; overlap admission itself lives in the Rust kernel.
 */
export class KernelPathLockService implements PathLockService {
  private readonly leases = new Map<string, KernelLockBinding>();
  private readonly pending = new Map<string, { ownerId: string; controller: AbortController; settled: Promise<void> }>();
  private disposed = false;

  constructor(
    private readonly adapter: KernelStorageAdapter,
    private readonly options: KernelPathLockServiceOptions,
  ) {}

  async acquire(ownerId: string, resource: PathLockResource, timeoutMs = 30_000): Promise<string> {
    if (this.disposed) throw new Error("Path lock service is disposed");
    const leaseId = `file-lock:${randomUUID()}`;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finish!: () => void;
    const settled = new Promise<void>(resolve => { finish = resolve; });
    this.pending.set(leaseId, { ownerId, controller, settled });
    try {
      const executionWorkspaceId = resource.workspaceId;
      const owningWorkspaceId = await this.options.resolveOwningWorkspaceId(ownerId, executionWorkspaceId);
      const canonicalRoot = await this.options.resolveWorkspaceRoot(executionWorkspaceId);
      const resourceId = normalizedResourceId(resource);
      controller.signal.throwIfAborted();
      const authority = await this.adapter.fileAuthorityContext({
        owningWorkspaceId, executionWorkspaceId, canonicalRoot, purpose: "file-writer-lock",
        actor: { owningWorkspace: owningWorkspaceId, executionWorkspace: executionWorkspaceId,
          sessionId: ownerId, pathScopes: [resourceId] },
      });
      controller.signal.throwIfAborted();
      timer = setTimeout(() => controller.abort(new Error(`Lock timeout after ${timeoutMs}ms for resource: ${resource.canonicalResourceId}`)), timeoutMs);
      const result = await authority.client.fileLeaseWait({
        workspaceId: owningWorkspaceId,
        rootId: authority.rootId,
        leaseId,
        resources: [{ path: resourceId, scope: "exact" }],
      }, controller.signal);
      if (result.status !== "acquired") throw new Error("Kernel returned an invalid file lease result");
      if (controller.signal.aborted) {
        await authority.client.fileLeaseRelease({ workspaceId: owningWorkspaceId, rootId: authority.rootId, leaseId });
        controller.signal.throwIfAborted();
      }
      this.leases.set(leaseId, {
        ownerId, workspaceId: owningWorkspaceId, rootId: authority.rootId, client: authority.client,
      });
      return leaseId;
    } catch (error) {
      if (controller.signal.aborted && error instanceof KernelClientError && error.code === "cancelled") throw controller.signal.reason;
      throw error;
    } finally { clearTimeout(timer); this.pending.delete(leaseId); finish(); }
  }

  async release(ownerId: string, leaseId: string): Promise<boolean> {
    const binding = this.leases.get(leaseId);
    if (!binding || binding.ownerId !== ownerId) return false;
    const result = await binding.client.fileLeaseRelease({
      workspaceId: binding.workspaceId,
      rootId: binding.rootId,
      leaseId,
    }).catch(() => ({ released: false }));
    this.leases.delete(leaseId);
    return result.released === true;
  }

  async dropSession(ownerId: string): Promise<void> {
    const pending = [...this.pending.values()].filter(wait => wait.ownerId === ownerId);
    for (const wait of pending) wait.controller.abort(new Error("Path lock owner was dropped"));
    await Promise.all(pending.map(wait => wait.settled));
    const leaseIds = [...this.leases.entries()]
      .filter(([, binding]) => binding.ownerId === ownerId)
      .map(([leaseId]) => leaseId);
    await Promise.all(leaseIds.map((leaseId) => this.release(ownerId, leaseId).catch(() => false)));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const pending = [...this.pending.values()];
    for (const wait of pending) wait.controller.abort(new Error("Path lock service is disposed"));
    await Promise.all(pending.map(wait => wait.settled));
    const entries = [...this.leases.entries()];
    await Promise.all(entries.map(([leaseId, binding]) => (
      this.release(binding.ownerId, leaseId).catch(() => false)
    )));
    this.leases.clear();
  }
}
