import { expect, it } from 'vitest';
import { createUiContentStore } from './store.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import type { KernelRecordResult, MaterialRetention } from '../kernel/protocol.generated.js';

function fixture() {
  const rows = new Map<string, KernelRecordResult>(), operations = new Map<string, unknown>();
  let revision = 0, deleted = false;
  let beforePut: ((id: string) => Promise<void>) | undefined;
  const client = {
    getRecord: async (_workspace: string, ref: string) => rows.get(ref) ?? null,
    getOperation: async (ref: string) => operations.get(ref) ?? null,
    putRecord: async (input: KernelRecordResult & { operationId: string }) => {
      await beforePut?.(input.recordId);
      const value = { ...input, createdAt: 1, updatedAt: ++revision, recordRevision: revision };
      rows.set(input.recordId, value); operations.set(input.operationId, { state: 'committed', result: value }); return value;
    },
    releaseOperation: async () => {},
    releaseRecord: async (_operation: string, _workspace: string, ref: string) => { rows.delete(ref); return { released: true }; },
    listRecords: async () => ({ records: [...rows.values()], nextCursor: null }),
  };
  const store = createUiContentStore({ issueGrant: async () => ({}), scoped: () => client } as unknown as KernelClient,
    undefined, async () => { if (deleted) throw new Error('Original conversation was deleted'); });
  return { store, rows, deleteOwner: () => { deleted = true; }, delayPut: (before: typeof beforePut) => { beforePut = before; } };
}
const identity = { threadId: 'thread', branchId: 'main' };
const plan = (uiReferences: string[] = []): MaterialRetention => ({ uiReferences, threads: [{ threadId: 'thread', rootThreadId: 'thread', release: true }],
  sources: [], attachments: [], inheritances: [], attachmentPreparations: [], attachmentSources: [] });
const state = { data: { answer: 'value' }, controls: {}, scroll: { x: 0, y: 5 } };
it('retains the frozen selected result after owner deletion, then releases it when native history no longer holds it', async () => {
  const f = fixture();
  const work = await f.store.render('thread', { content: { type: 'input', label: 'Question' } }, 'original', undefined, undefined, identity);
  await f.store.saveView('thread', 'ui-view:one', { branchScope: identity, source: { ref: work.ref }, state, lease: { token: 'lease', clientId: 'client' } });
  const selected = await f.store.select('thread', { ref: work.ref, viewRef: 'ui-view:one', capturedAt: '2026-11-04T00:00:00Z', state, viewport: { width: 1, height: 1 } }, { text: 'value' }, identity);
  f.deleteOwner();
  await f.store.collect('thread', plan([selected.ref]));
  expect(await f.store.selection('thread', selected.ref)).toMatchObject({ ref: selected.ref, text: 'value' });
  expect(await f.store.view('thread', 'ui-view:one')).toBeNull();
  await expect(f.store.saveView('thread', 'ui-view:late', { branchScope: identity, source: { ref: work.ref }, state })).rejects.toThrow('deleted');
  await expect(f.store.select('thread', { ref: work.ref, viewRef: 'ui-view:one', capturedAt: 'now', state, viewport: { width: 1, height: 1 } }, {}, identity)).rejects.toThrow('deleted');
  await f.store.collect('thread', plan());
  expect(f.rows.size).toBe(0);
  await expect(f.store.source('thread', work.ref)).rejects.toMatchObject({ status: 404 });
});
it('waits for admitted UI writes to settle before collection and rejects a late writer after the barrier', async () => {
  const f = fixture(); let reached!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  f.delayPut(async id => { if (id.startsWith('ui:')) { reached(); await new Promise<void>(resolve => { finish = resolve; }); } });
  const writing = f.store.render('thread', { content: { type: 'input', label: 'Question' } }, 'original', undefined, undefined, identity);
  await started; f.deleteOwner();
  let collected = false;
  const collection = f.store.collect('thread', plan()).then(() => { collected = true; });
  const late = f.store.saveView('thread', 'ui-view:late', { branchScope: identity, source: { preview: { callId: 'late', sequence: 1, contents: {}, entry: '', title: 'Late' } } });
  const rejected = expect(late).rejects.toThrow('deleted');
  await Promise.resolve(); expect(collected).toBe(false);
  finish(); await writing; await collection; await rejected;
  expect(f.rows.size).toBe(0);
});
