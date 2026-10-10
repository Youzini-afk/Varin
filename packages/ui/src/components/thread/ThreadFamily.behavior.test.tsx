import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ThreadIdentity, ThreadFamilyAPI } from '@varin/application-client';
import type { FamilyList, FamilyRead } from '@varin/protocol';
import { ThreadFamily } from './ThreadFamily';
const endpoint = vi.hoisted(() => ({ generation: 1, listeners: new Set<() => void>() }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(),
  getRuntimeEndpointGeneration: () => endpoint.generation,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { endpoint.listeners.add(listener); return () => endpoint.listeners.delete(listener); },
}));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));
const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:caller', branchId: 'branch:caller' };
const family: FamilyList = { rootThreadId: 'thread:root', members: ['first', 'second'].map(name => ({ threadId: `thread:${name}`, parentThreadId: 'thread:root', task: `${name} task`, state: 'reported',
  branches: [{ branchId: `branch:${name}`, headId: 'head', activeRunId: null, latestRun: { runId: 'run:original', state: 'completed' } }] })) };
const page = (text = 'original answer'): FamilyRead => ({ threadId: 'thread:first', branchId: 'branch:first', runId: null, headId: 'fixed-head', anchor: 'signed-fixed-anchor', nextCursor: null, scanned: 1, scanComplete: true, hasEarlier: false, hasLater: false,
  items: [{ id: 'original-record', parentId: null, sequence: 8, runId: 'run:original', source: 'assistant', kind: 'text', body: { text }, preview: '', bodyBytes: 100, bodyTruncated: false, tool: null }] });
function fixture() {
  return {
    list: vi.fn<ThreadFamilyAPI['list']>(async () => family),
    runs: vi.fn<ThreadFamilyAPI['runs']>(async (_caller, target) => ({ ...target, runs: [{ runId: 'run:original', branchId: target.branchId, state: 'completed' }], nextCursor: null })),
    read: vi.fn<ThreadFamilyAPI['read']>(async () => page()),
    item: vi.fn<ThreadFamilyAPI['item']>(async (_caller, request) => ({ ...request, runId: null, headId: 'fixed-head', format: 'conversation_json', text: request.offset ? 'tail' : 'prefix', offset: request.offset ?? 0, nextOffset: request.offset ? null : 6, totalBytes: 10 })),
  };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  endpoint.generation = 1;
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = async (api: ThreadFamilyAPI, selected = identity) => { await act(async () => root.render(<ThreadFamily api={api} identity={selected} />)); };
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === label)!;
const click = async (label: string) => { await act(async () => button(label).click()); };

it('reads on demand, keeps saved Run/tool identities, and pages original partial JSON under the same fixed anchor', async () => {
  const api = fixture(); const partial = page(); partial.items[0] = { ...partial.items[0], body: null, preview: '{"tool_result":', bodyTruncated: true,
    kind: 'tool_result', tool: { requestId: 'request:original', callId: 'call:original', role: 'result' } };
  partial.nextCursor = 'next-old-records'; partial.scanComplete = false;
  api.read.mockResolvedValueOnce(partial);
  await render(api); expect(api.list).not.toHaveBeenCalled();
  await click('Browse task family'); expect(api.list).toHaveBeenCalledWith(identity, false, expect.any(AbortSignal));
  await click('first task');
  expect(api.read.mock.calls[0]!.slice(0, 2)).toEqual([identity, { threadId: 'thread:first', branchId: 'branch:first', query: { kind: 'recent' }, anchor: undefined, cursor: undefined }]);
  expect(container.textContent).toContain('run:original'); expect(container.textContent).toContain('call:original');
  expect(container.textContent).toContain('Partial preview'); expect(container.textContent).not.toContain('original answer');
  await click('Read original record'); expect(container.textContent).toContain('partial JSON page');
  await click('Next original page');
  expect(api.item.mock.calls[1]![1]).toMatchObject({ anchor: 'signed-fixed-anchor', itemId: 'original-record', offset: 6 });
  expect(container.querySelector('[aria-label="Original family record"]')!.textContent).toContain('tail');
  await click('Continue history');
  expect(api.read.mock.calls[1]![1]).toMatchObject({ anchor: 'signed-fixed-anchor', cursor: 'next-old-records', query: { kind: 'recent' } });
  expect(container.querySelector('[aria-label="Original family record"]')).toBeNull();
});

it('aborts superseded targets and closed views and discards late results even when a transport ignores cancellation', async () => {
  const api = fixture(); const old = deferred<FamilyRead>(); api.read.mockReturnValueOnce(old.promise);
  await render(api); await click('Browse task family'); await click('first task');
  const signal = api.read.mock.calls[0]![2]!;
  await click('second task'); expect(signal.aborted).toBe(true);
  await act(async () => old.resolve(page('late first task data')));
  expect(container.textContent).not.toContain('late first task data');
  expect(api.read.mock.calls[1]![1]).toMatchObject({ threadId: 'thread:second', branchId: 'branch:second' });
  const active = api.read.mock.calls[1]![2]!;
  await click('Hide task family'); expect(active.aborted).toBe(true);
  expect(container.querySelector('[aria-label="Family conversation history"]')).toBeNull();
});

it('drops previous Host and caller views, and distinguishes empty pages from read failure', async () => {
  const api = fixture(); const old = deferred<FamilyList>(); api.list.mockReturnValueOnce(old.promise);
  await render(api); await click('Browse task family'); const oldSignal = api.list.mock.calls[0]![2]!;
  await act(async () => { endpoint.generation++; for (const listener of endpoint.listeners) listener(); });
  expect(oldSignal.aborted).toBe(true);
  await act(async () => old.resolve(family)); expect(container.textContent).not.toContain('first task');
  await click('Browse task family'); api.read.mockRejectedValueOnce(new Error('stale epoch'));
  await click('first task'); expect(container.textContent).toContain('Could not read this view'); expect(container.textContent).not.toContain('No matching');
  api.read.mockResolvedValueOnce({ ...page(), items: [] }); await click('Read latest saved view');
  expect(container.textContent).toContain('No matching conversation records');
  await render(api, { ...identity, branchId: 'branch:new' }); expect(container.textContent).not.toContain('first task');
  expect(container.querySelector('[aria-label="Family conversation history"]')).toBeNull();
});

it('uses the selected historical Run and fixed range boundaries without starting the other conversation', async () => {
  const api = fixture(); api.read.mockResolvedValue({ ...page(), hasEarlier: true, hasLater: true });
  await render(api); await click('Browse task family'); await click('first task');
  const select = container.querySelector<HTMLSelectElement>('[aria-label="Family Run"]')!;
  await act(async () => { Object.defineProperty(select, 'value', { configurable: true, writable: true, value: 'run:original' }); select.dispatchEvent(new window.Event('change', { bubbles: true })); });
  expect(api.read.mock.calls.at(-1)![1]).toMatchObject({ runId: 'run:original', query: { kind: 'recent' } });
  await click('Earlier records');
  expect(api.read.mock.calls.at(-1)![1]).toMatchObject({ runId: 'run:original', anchor: 'signed-fixed-anchor', query: { kind: 'range', beforeId: 'original-record', direction: 'older' } });
  await click('Later records');
  expect(api.read.mock.calls.at(-1)![1]).toMatchObject({ query: { kind: 'range', afterId: 'original-record', direction: 'newer' } });
});
