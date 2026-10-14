import { expect, it, vi } from 'vitest';
import type { WorkspaceRecoveryTurnSettledInput } from '@varin/extension-contract';
import { KernelRecoveryStore } from './kernel-recovery-store.js';
import type { KernelStorageAdapter } from './storage-adapter.js';

function fixture() {
  let row: Record<string, unknown> = { workspaceId: 'workspace', executionId: 'run:input', checkpointId: 'checkpoint',
    conversation: { kind: 'thread', threadId: 'thread', branchId: 'history' }, runId: 'run', userEntryId: 'input',
    assistantEntryId: null, runtimeKey: 'thread', runtimeGeneration: 1, workerId: 'kernel', status: 'pending', revision: 1,
    activeWriterScopes: [], observedResourceIds: [], unrecordedResourceIds: [], failure: null,
    provenance: 'caused-by', startedAt: '2026-10-14T00:00:00.000Z', settledAt: null };
  const receipts = new Map<string, { params: string; value: Record<string, unknown> }>();
  const state = { loseReply: false };
  const settle = vi.fn(async (input: Record<string, unknown>) => {
    const key = String(input.operationId), params = JSON.stringify(input);
    const previous = receipts.get(key);
    if (previous) {
      if (previous.params !== params) throw new Error('Original operation identity changed');
      return structuredClone(previous.value);
    }
    if (row.revision !== input.expectedRevision) throw new Error('Recovery turn revision conflict');
    row = { ...row, status: input.status, revision: Number(row.revision) + 1,
      observedResourceIds: input.observedResourceIds, unrecordedResourceIds: input.unrecordedResourceIds,
      activeWriterScopes: input.activeWriterScopes, provenance: input.provenance,
      assistantEntryId: input.assistantEntryId ?? null,
      failure: typeof input.failureJson === 'string' ? JSON.parse(input.failureJson) : null,
      settledAt: '2026-10-14T00:01:00.000Z' };
    receipts.set(key, { params, value: structuredClone(row) });
    if (state.loseReply) { state.loseReply = false; throw new Error('Settled response lost'); }
    return structuredClone(row);
  });
  const adapter = { context: async () => ({ client: {
    recoveryTurnGet: async () => structuredClone(row), recoveryChangeList: async () => ({ changes: [{ path: 'a.ts' }] }),
    recoveryTurnSettle: settle,
  } }) } as unknown as KernelStorageAdapter;
  const store = new KernelRecoveryStore(adapter, {} as never);
  const input: WorkspaceRecoveryTurnSettledInput = { workspaceId: 'workspace', executionId: 'run:input',
    activeWriterScopes: [], observedResourceIds: ['a.ts'], observationComplete: true, mutationObserved: true,
    provenance: 'caused-by', assistantEntryId: 'answer' };
  return { store, input, settle, state };
}

it('recalls repeated settlement from the original checkpoint without changing its operation identity', async () => {
  const h = fixture();
  const original = await h.store.recordTurnSettled(h.input);
  expect(await h.store.recordTurnSettled(h.input)).toEqual(original);
  expect(h.settle).toHaveBeenCalledOnce();
  expect(original.status).toBe('ready');
});

it('recovers a lost settlement reply from the same committed checkpoint', async () => {
  const h = fixture(); h.state.loseReply = true;
  await expect(h.store.recordTurnSettled(h.input)).rejects.toThrow('response lost');
  expect(await h.store.recordTurnSettled(h.input)).toMatchObject({ status: 'ready', executionId: 'run:input' });
  expect(h.settle).toHaveBeenCalledOnce();
});

it('commits new incomplete coverage using the original revision CAS and keeps it on later retries', async () => {
  const h = fixture();
  await h.store.recordTurnSettled(h.input);
  const changed = { ...h.input, observedResourceIds: ['a.ts', 'external.ts'] };
  const result = await h.store.recordTurnSettled(changed);
  expect(result).toMatchObject({ status: 'incomplete', unrecordedResourceIds: ['external.ts'],
    failure: { code: 'checkpoint-incomplete' } });
  expect(h.settle.mock.calls.map(([input]) => input.expectedRevision)).toEqual([1, 2]);
  expect(h.settle.mock.calls[0]![0].operationId).not.toBe(h.settle.mock.calls[1]![0].operationId);
  expect(await h.store.recordTurnSettled(changed)).toEqual(result);
  expect(h.settle).toHaveBeenCalledTimes(2);
});
