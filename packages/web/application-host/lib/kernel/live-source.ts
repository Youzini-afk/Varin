import { randomUUID } from 'node:crypto';
import type { LiveRoot } from './protocol.generated.js';
import type { KernelClient } from './kernel-client.js';
import { canonicalizePathIdentity } from '../workspace/path-safety.js';

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
      || workspace.root !== source.liveRoot.canonicalRoot || execution.root !== source.liveRoot.canonicalRoot
      || await canonicalizePathIdentity(workspace.root) !== source.liveRoot.canonicalRoot) {
      throw new Error('Live workspace identity changed; select the workspace again');
    }
    signal?.throwIfAborted();
  };
  const prepare = async (workspaceId: string, executionWorkspaceId: string, threadId: string): Promise<LiveRoot> => {
    const workspace = await documents.inspectWorkspace(workspaceId);
    const source = { workspaceId, executionWorkspaceId,
      liveRoot: { hostId: workspace.hostId, canonicalRoot: workspace.root, rootId: '' } };
    await validate(source);
    const grant = await kernel.issueGrant({ grantId: `live-admission:${randomUUID()}`,
      owningWorkspace: workspaceId, executionWorkspace: executionWorkspaceId, threadId,
      capabilities: ['storage.read', 'storage.write'], pathScopes: [''] });
    try {
      const registered = await kernel.scoped(grant).fileRootRegister({ workspaceId, executionWorkspaceId, canonicalRoot: workspace.root });
      if (typeof registered.rootId !== 'string' || registered.canonicalRoot !== workspace.root) throw new Error('Live root admission failed');
      return { ...source.liveRoot, rootId: registered.rootId };
    } finally { await kernel.revokeGrant(grant.grantId); }
  };
  const admit = async (source: LiveSourceSelection, threadId: string): Promise<void> => {
    await validate(source);
    const actual = await prepare(source.workspaceId, source.executionWorkspaceId, threadId);
    if (actual.rootId !== source.liveRoot.rootId) throw new Error('Live root registration does not match the selected source');
  };
  return { prepare, validate, admit };
}
export type LiveSourceOwner = ReturnType<typeof createLiveSourceOwner>;
