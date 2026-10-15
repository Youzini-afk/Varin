import { randomUUID } from 'node:crypto';
import type { LiveRoot } from './protocol.generated.js';
import type { KernelClient } from './kernel-client.js';
import { canonicalizePathIdentity, normalizePathIdentity } from '../workspace/path-safety.js';

export interface LiveSourceSelection {
  workspaceId: string; executionWorkspaceId: string; liveRoot: LiveRoot;
}
export type LiveSourceResolver = (source: LiveSourceSelection, signal?: AbortSignal) => Promise<void>;
interface Owners {
  documents: { inspectWorkspace(workspaceId: string, options?: { signal?: AbortSignal }): Promise<{ root: string; hostId: string }> };
  kernel: KernelClient;
}

/** Admission adapter only. Documents owns durable roots; Rust owns registrations and grants. */
export function createLiveSourceOwner({ documents, kernel }: Owners) {
  const validate: LiveSourceResolver = async (source, signal) => {
    signal?.throwIfAborted();
    const [workspace, execution] = await Promise.all([
      documents.inspectWorkspace(source.workspaceId, signal ? { signal } : {}),
      documents.inspectWorkspace(source.executionWorkspaceId, signal ? { signal } : {}),
    ]);
    const handshake = kernel.handshake ?? await kernel.start();
    if (source.liveRoot.hostId !== handshake.hostId || workspace.hostId !== source.liveRoot.hostId
      || execution.hostId !== source.liveRoot.hostId
      || normalizePathIdentity(workspace.root) !== normalizePathIdentity(source.liveRoot.canonicalRoot)
      || normalizePathIdentity(execution.root) !== normalizePathIdentity(source.liveRoot.canonicalRoot)
      || normalizePathIdentity(await canonicalizePathIdentity(workspace.root)) !== normalizePathIdentity(source.liveRoot.canonicalRoot)) {
      throw new Error('Live workspace identity changed; select the workspace again');
    }
    signal?.throwIfAborted();
  };
  const prepare = async (workspaceId: string, executionWorkspaceId: string, threadId: string, signal?: AbortSignal): Promise<LiveRoot> => {
    const workspace = await documents.inspectWorkspace(workspaceId, signal ? { signal } : {});
    const source = { workspaceId, executionWorkspaceId,
      liveRoot: { hostId: workspace.hostId, canonicalRoot: workspace.root, rootId: '' } };
    await validate(source, signal);
    const grant = await kernel.issueGrant({ grantId: `live-admission:${randomUUID()}`,
      owningWorkspace: workspaceId, executionWorkspace: executionWorkspaceId, threadId,
      capabilities: ['storage.read', 'storage.write'], pathScopes: [''] }, signal);
    try {
      const registered = await kernel.scoped(grant).fileRootRegister({ workspaceId, executionWorkspaceId, canonicalRoot: workspace.root }, signal);
      if (typeof registered.rootId !== 'string' || typeof registered.canonicalRoot !== 'string'
        || normalizePathIdentity(registered.canonicalRoot) !== normalizePathIdentity(workspace.root)) throw new Error('Live root admission failed');
      return { ...source.liveRoot, rootId: registered.rootId };
    } finally { await kernel.revokeGrant(grant.grantId); }
  };
  const admit = async (source: LiveSourceSelection, threadId: string, signal?: AbortSignal): Promise<void> => {
    await validate(source, signal);
    const actual = await prepare(source.workspaceId, source.executionWorkspaceId, threadId, signal);
    if (actual.rootId !== source.liveRoot.rootId) throw new Error('Live root registration does not match the selected source');
  };
  return { prepare, validate, admit };
}
export type LiveSourceOwner = ReturnType<typeof createLiveSourceOwner>;
