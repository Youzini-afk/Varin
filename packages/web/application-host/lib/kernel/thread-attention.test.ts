import { expect, it, vi } from 'vitest';
import { readThreadAttention, type AttentionBotProfile, type NativeThreadAttentionSnapshot } from './thread-attention.js';

function fixture() {
  const profile: AttentionBotProfile = { botId: 'bot', recordRevision: 3,
    entry: { runtime: 'agent', threadId: 'entry', branchId: 'entry-branch' } };
  const native: NativeThreadAttentionSnapshot = { epoch: 7, eventCursor: 20,
    coverage: { native: 'complete', external: 'unsupported', scope: 'host' },
    branches: [{ threadId: 'entry', branchId: 'entry-branch', botId: 'bot', title: 'Entry',
      parentThreadId: null, archived: false, deleted: false, activeRunId: null,
      currentRun: null, latestRun: null, hasUnsettledWork: true }],
    items: [{ key: 'root-question', threadId: 'entry', branchId: 'entry-branch', runId: 'run', revision: 1, kind: 'question', actionable: true }],
    teamExecutions: [], delegations: [], counts: { actionRequired: 1, affectedBranches: 1, unknownEffects: 0 },
    botGates: [{ botId: 'bot', profileRevision: 3, kernelEpoch: 7 }] };
  return { profile, native, read: vi.fn(async () => native) };
}
it('decorates the exact entry only with a matching cross-owner proof and keeps root requests', async () => {
  const f = fixture();
  const result = await readThreadAttention(f.read, async () => [f.profile]);
  expect(result.botEntries).toEqual([{ botId: 'bot', threadId: 'entry', branchId: 'entry-branch', profileRevision: 3 }]);
  expect(result).not.toHaveProperty('botGates');
  expect(result.items).toBe(f.native.items); expect(result.counts).toBe(f.native.counts);
  expect(f.read).toHaveBeenCalledTimes(1);
});
it.each(['revision', 'epoch', 'ownership', 'unavailable'] as const)('leaves original facts intact on %s proof failure', async cause => {
  const f = fixture();
  if (cause === 'revision') f.profile.recordRevision++;
  if (cause === 'epoch') f.native.botGates![0]!.kernelEpoch++;
  const profiles = async () => { if (cause === 'unavailable') throw new Error('Storage unavailable'); return [f.profile]; };
  if (cause === 'ownership') f.native.branches[0]!.botId = 'other-bot';
  const result = await readThreadAttention(f.read, profiles);
  expect(result.botEntries).toEqual([]);
  expect(result.items).toBe(f.native.items); expect(result.branches).toBe(f.native.branches);
  expect(result.counts).toBe(f.native.counts); expect(result).not.toHaveProperty('botGates');
  expect(f.read).toHaveBeenCalledTimes(2);
});
it('rechecks one concurrent profile publication immediately rather than waiting for another observation', async () => {
  const f = fixture(); let calls = 0;
  const profiles = async () => [{ ...f.profile, recordRevision: calls++ === 0 ? 2 : 3 }];
  const result = await readThreadAttention(f.read, profiles);
  expect(result.botEntries).toHaveLength(1); expect(f.read).toHaveBeenCalledTimes(2);
});
it('keeps old-host role evidence unknown and does not suppress native failures', async () => {
  const f = fixture(); delete f.native.botGates;
  expect(await readThreadAttention(f.read, async () => [f.profile])).not.toHaveProperty('botEntries');
  await expect(readThreadAttention(async () => { throw new Error('native unavailable'); }, async () => [f.profile])).rejects.toThrow('native unavailable');
});

it('cancels the observer promptly while a shared profile read is still pending', async () => {
  const f = fixture(); const controller = new AbortController();
  let complete!: (profiles: AttentionBotProfile[]) => void;
  const shared = new Promise<AttentionBotProfile[]>(resolve => { complete = resolve; });
  const pending = readThreadAttention(f.read, () => shared, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort(); await rejected;
  expect(f.read).not.toHaveBeenCalled();
  complete([f.profile]);
});
