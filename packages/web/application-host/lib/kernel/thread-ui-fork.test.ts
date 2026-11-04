import { expect, it, vi } from 'vitest';
import { ThreadAdapter } from './thread-adapter.js';

it('freezes exploration before the native fork and never recaptures an existing branch from a later parent state', async () => {
  const identity = { runtime: 'agent' as const, threadId: 'thread:test', branchId: 'branch:main' };
  const branches = [{ branch_id: identity.branchId }], order: string[] = [];
  let fail = false;
  const forkBranch = vi.fn(async (_source: string, branchId: string) => {
    order.push('fork'); if (fail) throw new Error('Native fork rejected');
    if (!branches.some(branch => branch.branch_id === branchId)) branches.push({ branch_id: branchId });
    return { threadId: identity.threadId, branchId };
  });
  const adapter = new ThreadAdapter({ thread: async () => ({ branches: [...branches] }), forkBranch } as never, {} as never, vi.fn(), vi.fn());
  const capture = vi.fn(async () => { order.push('capture'); }); adapter.bindInteractiveUiFork(capture);
  const request = { ...identity, key: 'fork', headId: 'message' };
  const created = await adapter.fork(request);
  expect(order).toEqual(['capture', 'fork']);
  order.length = 0;
  expect(await adapter.fork(request)).toEqual(created);
  expect(order).toEqual(['fork']); expect(capture).toHaveBeenCalledTimes(1);
  fail = true; order.length = 0;
  await expect(adapter.fork({ ...request, key: 'failed' })).rejects.toThrow('Native fork rejected');
  expect(order).toEqual(['capture', 'fork']); expect(branches).toHaveLength(2);
  capture.mockRejectedValueOnce(new Error('Snapshot save unavailable'));
  order.length = 0; await expect(adapter.fork({ ...request, key: 'capture-failed' })).rejects.toThrow('Snapshot save unavailable');
  expect(order).toEqual([]);
});
