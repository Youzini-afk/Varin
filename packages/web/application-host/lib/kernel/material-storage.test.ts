import { expect, it, vi } from 'vitest';
import { createMaterialStorageAccess, threadMaterialScope } from './material-storage.js';
import type { KernelClient } from './kernel-client.js';
import type { KernelStorageAdapter } from './storage-adapter.js';

it('keeps service grants private, separates read/write capabilities and preserves settled effects across cleanup failure', async () => {
  const calls: Record<string, unknown>[] = [], diagnostics: unknown[] = [];
  const cleanupError = new Error('original revoke failed');
  let finish!: () => void;
  const cleanup = new Promise<void>(resolve => { finish = resolve; });
  const kernel = {
    issueGrant: async (grant: Record<string, unknown>) => { calls.push(grant); return grant; },
    revokeGrant: vi.fn(async () => { await cleanup; throw cleanupError; }),
  } as unknown as KernelClient;
  const storage = { contextFromBranchGrant: async (context: unknown) => context } as unknown as KernelStorageAdapter;
  const access = createMaterialStorageAccess({ kernel, storage, onCleanupError: error => { diagnostics.push(error); } });
  const scope = threadMaterialScope('root');
  await expect(access.withBranchStore('workspace:legacy', 'material-collections-read', async () => null, 'exclusive', { threadId: 'reader' })).rejects.toThrow('Thread-family scope');
  await expect(access.withBranchStore(threadMaterialScope(''), 'material-collections-read', async () => null, 'exclusive', { threadId: 'reader' })).rejects.toThrow('Thread-family scope');
  expect(calls).toEqual([]);
  let settled = false;
  const pending = access.withBranchStore(scope, 'material-collections-write', async () => ({ effect: 'confirmed', committed: 'original' }), 'exclusive', { threadId: 'reader' })
    .finally(() => { settled = true; });
  await vi.waitFor(() => expect(kernel.revokeGrant).toHaveBeenCalledOnce());
  expect(settled).toBe(false); finish();
  expect(await pending).toEqual({ effect: 'confirmed', committed: 'original' });
  expect(calls[0]).toMatchObject({ threadId: 'reader', owningWorkspace: scope, executionWorkspace: scope, pathScopes: [],
    capabilities: ['storage.read', 'storage.maintenance', 'storage.write'] });
  expect(diagnostics).toEqual([cleanupError]);
  await access.withBranchStore(scope, 'material-collections-read', async () => null, 'exclusive', { threadId: 'reader' });
  expect(calls[1]!.capabilities).toEqual(['storage.read', 'storage.maintenance']);
  const originalFailure = new Error('original mutation outcome unknown');
  await expect(access.withBranchStore(scope, 'material-collections-write', async () => { throw originalFailure; }, 'exclusive', { threadId: 'reader' })).rejects.toBe(originalFailure);
  await expect(access.withBranchStore(scope, 'material-collections-read', async () => null, 'exclusive', { threadId: 'reader', sessionId: 'pretend' })).rejects.toThrow('admitted Thread');
});
