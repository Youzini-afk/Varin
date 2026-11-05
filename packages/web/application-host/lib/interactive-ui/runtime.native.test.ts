import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createKernelClient } from '../kernel/kernel-client.js';
import { createInteractiveUiRuntime } from './runtime.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel/target/release', process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel');
const buildVersion = (JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;

it('reads a connected view live and reports a missing or disconnected view with its next readable references', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'varin-ui-runtime-'));
  const options = { hostId: 'ui-runtime', storageRoot: root, kernelPath, buildVersion, allowCargoDevRunner: false };
  let client = createKernelClient(options);
  try {
    await client.start();
    const ui = createInteractiveUiRuntime({ kernel: client, runtime: {} as never, media: {} as never });
    const family = 'thread-root';
    const saved = await ui.store.render(family, { title: 'Counter', changes: [{ op: 'write', file: 'index.html', text: '<p id="n">1</p>' }] }, 'render-1');
    const signal = new AbortController().signal;

    // No live view yet: the read explains how to obtain one instead of failing generically.
    const missing = await ui.read(family, { kind: 'ui', ref: saved.ref, view: 'state' }, signal);
    expect(missing).toMatchObject({ status: 'unavailable', code: 'ui_view_required', views: [] });
    expect(await ui.read(family, { kind: 'ui', ref: saved.ref, view: 'source', file: 'index.html' }, signal)).toMatchObject({ status: 'ready' });

    // A connected client answers the live state read through its own observation queue.
    const { viewRef, token } = await ui.attach(family, { ref: saved.ref }, undefined, 'client-a');
    const observing = ui.poll(family, viewRef, token, signal);
    await expect.poll(() => ui.read(family, { kind: 'ui', ref: saved.ref, view: 'summary' }, signal)).toMatchObject({ views: [viewRef] });
    const pending = ui.read(family, { kind: 'ui', ref: viewRef, view: 'state' }, signal);
    const request = await observing;
    expect(request).toMatchObject({ view: 'state' });
    ui.reply(family, viewRef, token, request!.id, { ref: saved.ref, viewRef, capturedAt: new Date().toISOString(),
      state: { data: { count: 2 }, controls: {}, scroll: { x: 0, y: 0 } }, viewport: { width: 300, height: 200 } });
    expect(await pending).toMatchObject({ status: 'ready', state: { data: { count: 2 } } });

    // A client without a capture surface keeps its explicit reason.
    const screen = ui.read(family, { kind: 'ui', ref: viewRef, view: 'screen' }, signal);
    const screenRequest = await ui.poll(family, viewRef, token, signal);
    ui.reply(family, viewRef, token, screenRequest!.id, { ref: saved.ref, viewRef, capturedAt: new Date().toISOString(),
      state: { data: null, controls: {}, scroll: { x: 0, y: 0 } }, viewport: { width: 300, height: 200 } });
    await expect(screen).rejects.toMatchObject({ code: 'ui_screen_capture_unsupported' });

    // After detaching, the live read is not answered from saved data and names the next references.
    await ui.detach(family, viewRef, token, { data: { count: 2 }, controls: {}, scroll: { x: 0, y: 0 } });
    expect(await ui.read(family, { kind: 'ui', ref: viewRef, view: 'state' }, signal)).toMatchObject({
      status: 'unavailable', code: 'ui_view_disconnected', source: saved.ref, savedStateAvailable: true,
      next: [{ kind: 'ui', ref: saved.ref, view: 'summary' }, { kind: 'ui', ref: saved.ref, view: 'source' }] });

    // An acknowledged explicit save survives immediate owner shutdown and a
    // fresh view attachment, without depending on detach or a live iframe.
    const connected = await ui.attach(family, { ref: saved.ref }, viewRef, 'client-a');
    const state = { data: { count: 7 }, controls: { '#n': '7' }, scroll: { x: 0, y: 42 } };
    expect(await ui.state(family, viewRef, connected.token, state)).toEqual({ saved: true });
    ui.close(); await client.close(); client = createKernelClient(options); await client.start();
    const reopened = createInteractiveUiRuntime({ kernel: client, runtime: {} as never, media: {} as never });
    const restored = await reopened.attach(family, { ref: saved.ref }, viewRef, 'client-a');
    expect(restored.state).toEqual(state);
    expect(restored.token).not.toBe(connected.token);
    await expect(reopened.state(family, viewRef, connected.token, { ...state, data: 'old client' })).rejects.toMatchObject({ status: 409 });
    reopened.close();
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it('registers only original assistant fragments, idempotently and independently per branch, retaining original source through revisions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'varin-ui-fragment-'));
  const client = createKernelClient({ hostId: 'ui-fragment', storageRoot: root, kernelPath, buildVersion, allowCargoDevRunner: false });
  const definition = { type: 'choice', label: '发型', options: ['短发', '长发'], action: '继续设计' };
  const text = '说明\n```varin-ui\n' + JSON.stringify(definition) + '\n```\n正文';
  const references = [
    { id: 'assistant', source: 'assistant', content_ref: 'original' },
    { id: 'user', source: 'user', content_ref: 'user' },
    { id: 'example', source: 'assistant', content_ref: 'example' },
  ];
  const runtime = {
    thread: async () => ({ branches: [{ branch_id: 'main' }, { branch_id: 'fork' }] }),
    familyList: async () => ({ rootThreadId: 'family' }),
    historyPage: async () => ({ head: 'assistant', items: references, previous: null }),
    historyItem: async (reference: { id: string; source: string }) => ({ ...reference, content: { content: { kind: 'text', text: reference.id === 'example' ? '````markdown\n' + text + '\n````' : text } } }),
  };
  try {
    await client.start();
    const ui = createInteractiveUiRuntime({ kernel: client, runtime: runtime as never, media: {} as never });
    const identity = { runtime: 'agent' as const, threadId: 'thread', branchId: 'main' };
    const registration = { messageId: 'assistant', fragmentKey: 'offset:3' };
    const initial = await ui.registerFragment(identity, registration);
    expect(initial.content).toMatchObject({ type: 'choice', options: [{ key: 'label:短发' }, { key: 'label:长发' }] });
    expect(initial.definition).toEqual(definition);
    expect(initial.messageFragment).toMatchObject({ ...registration, threadId: 'thread', branchId: 'main' });
    expect(await ui.registerFragment(identity, registration)).toEqual(initial);
    const fork = await ui.registerFragment({ ...identity, branchId: 'fork' }, registration);
    expect(fork.workRef).not.toBe(initial.workRef);
    const updated = await ui.store.render('family', { ref: initial.ref, content: { ...definition, options: ['短发', '长发', '新发型'] } }, 'update');
    expect(updated.revision).toBe(2);
    const branchUpdate = { ref: updated.ref, content: { ...definition, options: ['短发', '长发', '分支发型'] } };
    const branchReceipt = await ui.renderForBranch('family', branchUpdate, 'branch-update', { threadId: 'thread', branchId: 'fork' });
    expect(branchReceipt.workRef).not.toBe(updated.workRef);
    expect((await ui.store.source('family', branchReceipt.ref)).forkedFrom).toBe(updated.ref);
    expect(await ui.renderForBranch('family', branchUpdate, 'branch-update', { threadId: 'thread', branchId: 'fork' })).toEqual(branchReceipt);
    await expect(ui.renderForBranch('family', branchUpdate, 'another-stale-update', { threadId: 'thread', branchId: 'fork' })).rejects.toMatchObject({ status: 409 });
    expect((await ui.store.source('family', updated.workRef)).ref).toBe(updated.ref);
    expect((await ui.registerFragment(identity, registration)).ref).toBe(initial.ref);
    expect((await ui.store.source('family', fork.ref)).content).toEqual(initial.content);
    expect(await ui.read('family', { kind: 'ui', ref: updated.ref, view: 'source' }, new AbortController().signal)).toMatchObject({ content: { type: 'choice' }, definition: { options: ['短发', '长发', '新发型'] } });
    await expect(ui.registerFragment(identity, { ...registration, messageId: 'user' })).rejects.toMatchObject({ status: 404 });
    await expect(ui.registerFragment(identity, { ...registration, messageId: 'absent' })).rejects.toMatchObject({ status: 404 });
    await expect(ui.registerFragment(identity, { ...registration, messageId: 'example' })).rejects.toMatchObject({ status: 404 });
    await expect(ui.registerFragment(identity, { ...registration, contentVersion: 'forged' })).rejects.toMatchObject({ status: 409 });
    await expect(ui.registerFragment({ ...identity, branchId: 'absent' }, registration)).rejects.toMatchObject({ status: 404 });
    ui.close();
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

it('inherits HTML state only after its original successful tool receipt is inside the fork cut, across reopen and isolated revisions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'varin-ui-html-fork-'));
  const options = { hostId: 'ui-html-fork', storageRoot: root, kernelPath, buildVersion, allowCargoDevRunner: false };
  let client = createKernelClient(options);
  const main = { threadId: 'thread', branchId: 'main' }, child = { threadId: 'thread', branchId: 'child' };
  const records = new Map<string, unknown>();
  const runtime = {
    thread: async () => ({ branches: ['main', 'child', 'earlier'].map(branch_id => ({ branch_id })) }),
    familyList: async () => ({ rootThreadId: 'family' }),
    historyPage: async ({ headId }: { headId?: string }) => ({ head: headId, previous: null, items: headId === 'receipt-one'
      ? [{ id: 'receipt-one', source: 'tool', thread_id: 'thread', run_id: 'run', content_ref: 'receipt-body', parent: null }] : [] }),
    historyItem: async (reference: { id: string }) => ({ ...reference, content: records.get(reference.id) }),
  };
  try {
    await client.start();
    let ui = createInteractiveUiRuntime({ kernel: client, runtime: runtime as never, media: {} as never });
    const first = await ui.renderForBranch('family', { changes: [{ op: 'write', file: 'index.html', text: '<input id="amount">' }] }, 'request-one:tool:html', main);
    records.set('receipt-one', { content: { kind: 'tool_result', result: { request_id: 'request-one', call_id: 'html', completion: {
      kind: 'result', outcome: 'succeeded', effect: 'confirmed', content: { data: first, parts: [] },
    } } } });
    const view = await ui.attach('family', { ref: first.ref }, undefined, 'client', undefined, main);
    const initial = { data: { amount: 42 }, controls: { '#amount': '42' }, scroll: { x: 0, y: 20 } };
    await ui.state('family', view.viewRef, view.token, initial);
    await ui.captureBranch({ runtime: 'agent', ...main }, child.branchId, 'receipt-one');
    const later = await ui.renderForBranch('family', { ref: first.ref, changes: [{ op: 'write', file: 'index.html', text: '<input id="new-amount">' }] }, 'request-two:tool:html', main);
    await ui.state('family', view.viewRef, view.token, { ...initial, data: { amount: 99 } });
    await ui.captureBranch({ runtime: 'agent', ...main }, child.branchId, 'receipt-one');
    ui.close(); await client.close(); client = createKernelClient(options); await client.start();
    ui = createInteractiveUiRuntime({ kernel: client, runtime: runtime as never, media: {} as never });
    const restored = await ui.attach('family', { ref: first.ref }, undefined, 'client', undefined, child);
    expect(restored.state).toEqual(initial);
    expect((await ui.attach('family', { ref: later.ref }, undefined, 'client', undefined, child)).state).toBeNull();
    const change = { ref: first.ref, changes: [{ op: 'write' as const, file: 'index.html', text: '<p>Child</p>' }] };
    const edited = await ui.renderForBranch('family', change, 'child-edit', child);
    expect(edited.workRef).not.toBe(first.workRef);
    expect((await ui.store.source('family', first.workRef)).ref).toBe(later.ref);
    expect(await ui.renderForBranch('family', change, 'child-edit', child)).toEqual(edited);
    await expect(ui.renderForBranch('family', change, 'stale-child-edit', child)).rejects.toMatchObject({ status: 409 });
    await ui.captureBranch({ runtime: 'agent', ...main }, 'earlier', null);
    expect((await ui.attach('family', { ref: first.ref }, undefined, 'client', undefined, { ...main, branchId: 'earlier' })).state).toBeNull();
    ui.close();
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
