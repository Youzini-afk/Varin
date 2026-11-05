import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { createUiContentStore } from './store.js';
import type { KernelClient } from '../kernel/kernel-client.js';

/** Storage transport fixture only. UI capture, replay, filtering and migration run their
 * production owner code; actual durability remains in store.native.test.ts. */
function fixture() {
  const records = new Map<string, { recordId: string; recordType: string; state: string; payloadJson: string; updatedAt: number; recordRevision: number }>();
  const operations = new Map<string, unknown>(); let revision = 0;
  const scoped = {
    getRecord: async (_workspace: string, id: string) => records.get(id) ?? null,
    getOperation: async (id: string) => operations.get(id) ?? null,
    putRecord: async (input: { recordId: string; recordType: string; state: string; payloadJson: string; operationId: string }) => {
      const record = { ...input, updatedAt: ++revision, recordRevision: revision };
      records.set(input.recordId, record); operations.set(input.operationId, { state: 'committed', result: record }); return record;
    },
    listRecords: async ({ recordType }: { recordType: string }) => ({ records: [...records.values()].filter(record => record.recordType === recordType), nextCursor: null }),
    putBlob: async (bytes: Uint8Array) => ({ hash: `sha256-${createHash('sha256').update(bytes).digest('hex')}`, ownerId: 'temporary' }),
    releaseBlob: async () => {},
    releaseOperation: async () => {},
  };
  return createUiContentStore({ issueGrant: async () => ({}), scoped: () => scoped } as unknown as KernelClient);
}

it('inherits the frozen fork state, not later parent values, only for the original client and included message', async () => {
  const store = fixture(), main = { threadId: 'thread', branchId: 'main' }, child = { threadId: 'thread', branchId: 'child' };
  const fragment = { ...main, messageId: 'message', fragmentKey: 'offset:0', contentVersion: 'original' };
  const content = { type: 'choice', label: '发型', options: ['短发', '长发'] };
  const work = await store.render('family', { content }, 'original', undefined, fragment);
  const state = { data: { root: 'label:短发' }, controls: {}, scroll: { x: 0, y: 12 } };
  await store.saveView('family', 'ui-view:parent', { source: { ref: work.ref }, branchScope: main, state, lease: { clientId: 'client', token: 'lease' } });
  // Detaching must retain client attribution even though its lease is released.
  await store.saveView('family', 'ui-view:parent', { lease: null }, 'lease');
  await store.captureBranch('family', main, child, 'message', id => id === 'message');
  await store.saveView('family', 'ui-view:parent', { state: { ...state, data: { root: 'label:长发' } } });
  await store.captureBranch('family', main, child, 'message', () => true);
  const fork = await store.render('family', { content }, 'fork', undefined, { ...fragment, ...child });
  expect(await store.branchSeed('family', child, { ref: fork.ref }, 'client')).toMatchObject(state);
  expect(await store.branchSeed('family', child, { ref: fork.ref }, 'other-client')).toBeNull();
  const earlier = { ...child, branchId: 'earlier' };
  await store.captureBranch('family', main, earlier, null, () => false);
  expect(await store.branchSeed('family', earlier, { ref: fork.ref }, 'client')).toBeNull();
  const unrelated = await store.render('family', { content }, 'unrelated', undefined, { ...fragment, ...child, messageId: 'different' });
  expect(await store.branchSeed('family', child, { ref: unrelated.ref }, 'client')).toBeNull();
});

it('does not guess between independent same-client views and retains no preview as a saved assistant source', async () => {
  const store = fixture(), main = { threadId: 'thread', branchId: 'main' }, child = { threadId: 'thread', branchId: 'child' };
  const fragment = { ...main, messageId: 'message', fragmentKey: 'offset:0', contentVersion: 'original' };
  const content = { type: 'input', label: '预算', inputType: 'number' };
  const work = await store.render('family', { content }, 'original', undefined, fragment);
  for (const id of ['one', 'two']) await store.saveView('family', `ui-view:${id}`, { source: { ref: work.ref }, branchScope: main,
    state: { data: { root: id }, controls: {}, scroll: { x: 0, y: 0 } }, lease: { clientId: 'client', token: id } });
  await store.saveView('family', 'ui-view:preview', { source: { preview: { callId: 'stream', sequence: 0, entry: '', contents: {}, title: 'Preview',
    content: (await store.source('family', work.ref)).content!, messageFragment: fragment } }, branchScope: main,
    state: { data: { root: '24' }, controls: {}, scroll: { x: 0, y: 0 } }, lease: { clientId: 'preview-client', token: 'p' } });
  await store.captureBranch('family', main, child, 'message', () => true);
  const fork = await store.render('family', { content }, 'fork', undefined, { ...fragment, ...child });
  expect(await store.branchSeed('family', child, { ref: fork.ref }, 'client')).toBeNull();
  expect(await store.branchSeed('family', child, { ref: fork.ref }, 'preview-client')).toBeNull();
  await expect(store.captureBranch('family', main, child, 'different-head', () => true)).rejects.toMatchObject({ status: 409 });
});

it('inherits only an HTML revision proven at the history cut, freezing its state independently of later source edits', async () => {
  const store = fixture(), main = { threadId: 'thread', branchId: 'main' }, child = { threadId: 'thread', branchId: 'child' };
  const first = await store.render('family', { changes: [{ op: 'write', file: 'index.html', text: '<input>' }] }, 'request:tool:html');
  expect((await store.operationReceipt('family', 'request:tool:html'))?.ref).toBe(first.ref);
  expect(await store.operationReceipt('family', 'unrelated-tool')).toBeNull();
  const initial = { data: { amount: 42 }, controls: { '#amount': '42' }, scroll: { x: 0, y: 20 } };
  await store.saveView('family', 'ui-view:html', { source: { ref: first.ref }, branchScope: main, state: initial, lease: { clientId: 'client', token: 'lease' } });
  await store.captureBranch('family', main, child, 'tool-result', () => false, ref => ref === first.ref);
  const second = await store.render('family', { ref: first.ref, changes: [{ op: 'write', file: 'index.html', text: '<input value="later">' }] }, 'later:tool:html');
  await store.saveView('family', 'ui-view:html', { source: { ref: second.ref }, state: { ...initial, data: { amount: 99 } } }, 'lease');
  await store.captureBranch('family', main, child, 'tool-result', () => false, () => true);
  expect(await store.branchSeed('family', child, { ref: first.ref }, 'client')).toEqual(initial);
  expect(await store.branchSeed('family', child, { ref: second.ref }, 'client')).toBeNull();
  expect(await store.branchSeed('family', child, { ref: first.ref }, 'another-client')).toBeNull();
  const earlier = { ...child, branchId: 'before-tool-result' };
  await store.captureBranch('family', main, earlier, 'earlier-cut', () => false, () => false);
  expect(await store.branchSeed('family', earlier, { ref: second.ref }, 'client')).toBeNull();
});

it('does not treat an ancestral message as proof that its later declarative revision existed at the fork cut', async () => {
  const store = fixture(), main = { threadId: 'thread', branchId: 'main' }, child = { threadId: 'thread', branchId: 'child' };
  const fragment = { ...main, messageId: 'message', fragmentKey: 'offset:0', contentVersion: 'original' };
  const content = { type: 'input', label: '预算', inputType: 'number' };
  const first = await store.render('family', { content }, 'message-initial', undefined, fragment);
  const later = await store.render('family', { ref: first.ref, content: { ...content, unit: 'USD' } }, 'later-operation');
  const state = { data: { root: '42' }, controls: {}, scroll: { x: 0, y: 0 } };
  await store.saveView('family', 'ui-view:revised', { source: { ref: later.ref }, branchScope: main, state, lease: { clientId: 'client', token: 'lease' } });
  await store.captureBranch('family', main, child, 'message', () => true, () => false);
  const fork = await store.render('family', { content }, 'message-child', undefined, { ...fragment, ...child });
  expect(await store.branchSeed('family', child, { ref: fork.ref }, 'client')).toBeNull();
  const afterUpdate = { ...child, branchId: 'after-update' };
  await store.captureBranch('family', main, afterUpdate, 'later-result', () => true, ref => ref === later.ref);
  expect(await store.branchSeed('family', afterUpdate, { ref: later.ref }, 'client')).toMatchObject(state);
});
