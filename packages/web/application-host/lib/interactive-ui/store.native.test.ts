import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createKernelClient } from '../kernel/kernel-client.js';
import { createUiContentStore } from './store.js';
it('saves atomic revisions, retains original receipts and selections after reopening', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'varin-ui-content-'));
  const resolved = path.resolve(root); if (!resolved.startsWith(path.join(tmpdir(), 'varin-ui-content-'))) throw new Error('Unexpected fixture path');
  const repo = path.resolve(import.meta.dirname, '../../../../..');
  const buildVersion = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8')).version;
  const options = { hostId: 'ui-content-test', storageRoot: path.join(root, 'kernel'), buildVersion,
    kernelPath: process.env.VARIN_TEST_KERNEL_PATH!, allowCargoDevRunner: false };
  let client = createKernelClient(options);
  try {
    await client.start(); let store = createUiContentStore(client);
    const first = await store.render('thread-a', { title: 'Compare', changes: [{ op: 'write', file: 'index.html', text: 'AAA\nBBB' }] }, 'call-1');
    const second = await store.render('thread-a', { ref: first.ref, changes: [{ op: 'edit', file: 'index.html', edits: [{ oldText: 'AAA', newText: 'BBB' }, { oldText: 'BBB', newText: 'CCC' }] }, { op: 'write', file: 'style.css', text: 'body{color:red}' }] }, 'call-2');
    expect((await store.source('thread-a', second.ref)).contents['index.html']).toBe('BBB\nCCC');
    await expect(store.render('thread-a', { ref: first.ref, changes: [{ op: 'write', file: 'index.html', text: 'lost' }] }, 'stale')).rejects.toMatchObject({ status: 409 });
    await expect(store.render('thread-a', { ref: second.ref, changes: [{ op: 'write', file: 'index.html', text: 'partial' }, { op: 'edit', file: 'style.css', edits: [{ oldText: 'absent', newText: 'x' }] }] }, 'failed')).rejects.toThrow('match exactly once');
    expect((await store.source('thread-a', second.workRef)).ref).toBe(second.ref);
    expect((await store.render('thread-a', { ref: second.ref, changes: [] }, 'no-change')).ref).toBe(second.ref);
    await store.saveView('thread-a', 'ui-view:test', { source: { ref: second.ref }, lease: { token: 'first', clientId: 'client-a' } });
    await store.saveView('thread-a', 'ui-view:test', { state: { data: 7, controls: {}, scroll: { x: 0, y: 0 } } }, 'first');
    await store.saveView('thread-a', 'ui-view:test', { lease: { token: 'second', clientId: 'client-a' } });
    await expect(store.saveView('thread-a', 'ui-view:test', { state: null }, 'first')).rejects.toMatchObject({ status: 409 });
    expect((await store.view('thread-a', 'ui-view:test'))?.state?.data).toBe(7);
    const preview = await store.snapshot('thread-a', { preview: { callId: 'stream-call', sequence: 4, contents: { 'index.html': '<p>Unfinished' }, entry: 'index.html', title: 'Preview' },
      viewRef: 'ui-view:test', capturedAt: new Date().toISOString(), state: { data: null, controls: {}, scroll: { x: 0, y: 0 } }, viewport: { width: 300, height: 200 } });
    const selection = await store.select('thread-a', { ref: second.ref, viewRef: 'ui-view:test', capturedAt: new Date().toISOString(),
      state: { data: { amount: 42 }, controls: {}, scroll: { x: 0, y: 0 } }, viewport: { width: 300, height: 200 } }, { text: 'BBB' });
    await client.close(); client = createKernelClient(options); await client.start(); store = createUiContentStore(client);
    expect((await store.source('thread-a', first.ref)).contents['index.html']).toBe('AAA\nBBB');
    expect(await store.render('thread-a', { title: 'Compare', changes: [{ op: 'write', file: 'index.html', text: 'AAA\nBBB' }] }, 'call-1')).toEqual(first);
    expect((await store.selection('thread-a', selection.ref)).text).toBe('BBB');
    expect((await store.readSnapshot('thread-a', selection.snapshotRef)).state.data).toEqual({ amount: 42 });
    expect((await store.readSnapshot('thread-a', preview)).preview?.contents['index.html']).toBe('<p>Unfinished');
    await expect(store.source('thread-b', second.ref)).rejects.toMatchObject({ status: 404 });
  } finally {
    await client.close();
    await rm(resolved, { recursive: true, force: true });
  }
});
