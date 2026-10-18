import { expect, it, vi } from 'vitest';
import { KernelStorageAdapter } from './storage-adapter.js';
import type { KernelClient, KernelGrantHandle } from './kernel-client.js';

it('keeps remote-only recovery metadata on the existing Host store without admitting any physical root', async () => {
  const workspaceId = 'recovery-coordinator:coordinator-host';
  const scoped = {};
  const issueGrant = vi.fn(async (input: unknown) => ({ ...input as object, hostId: 'coordinator-host', kernelEpoch: 'epoch' } as unknown as KernelGrantHandle));
  const resolveWorkspaceRoot = vi.fn(async () => { throw new Error('No local workspace is registered'); });
  const resolveActor = vi.fn(async () => { throw new Error('No session actor exists'); });
  const adapter = new KernelStorageAdapter({ client: { issueGrant, scoped: () => scoped, subscribeExit: () => () => {} } as unknown as KernelClient,
    hostId: 'coordinator-host', storageRoot: '/host-owned-store', recoveryCoordinatorWorkspace: workspaceId,
    resolveWorkspaceRoot, resolveActor });
  const context = await adapter.context(workspaceId, 'recovery-maintenance');
  expect(context.identity).toEqual({ authorityId: 'coordinator-host', workspaceId, canonicalRoot: '', filesystemProfile: 'metadata' });
  expect(context.client).toBe(scoped);
  expect(issueGrant).toHaveBeenCalledWith(expect.objectContaining({ owningWorkspace: workspaceId, executionWorkspace: workspaceId,
    pathScopes: [], capabilities: ['storage.read', 'storage.write', 'recovery', 'recovery.maintenance'] }));
  expect(resolveWorkspaceRoot).not.toHaveBeenCalled(); expect(resolveActor).not.toHaveBeenCalled();
  await expect(context.resolveFileRoot('/same-name-as-remote')).rejects.toThrow('no physical file authority');
  await expect(context.resolveMaterializationRoot('/same-name-as-remote')).rejects.toThrow('separately admitted');
  await expect(context.fileStore.applyState(context.identity, context.root, 'file', { kind: 'missing' })).rejects.toThrow('no physical file authority');
  await expect(adapter.context(workspaceId, 'recovery-actor')).rejects.toThrow('does not admit');
  await adapter.context(workspaceId, 'recovery-maintenance');
  expect(issueGrant).toHaveBeenCalledOnce();
});
