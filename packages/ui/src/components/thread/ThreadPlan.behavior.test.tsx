import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThreadRequestError } from '@varin/application-client';
import type { ThreadIdentity, ThreadPlanAPI, ThreadPlanState } from '@varin/application-client';
import type { PlanMutationResult } from '@varin/protocol';
import type { VarinEvent } from '@/lib/varinEvents';
import { ThreadPlan } from './ThreadPlan';

const endpoint = vi.hoisted(() => ({ generation: 1, listeners: new Set<() => void>() }));
vi.mock('@varin/application-client', async importOriginal => ({
  ...await importOriginal<typeof import('@varin/application-client')>(),
  getRuntimeEndpointGeneration: () => endpoint.generation,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { endpoint.listeners.add(listener); return () => endpoint.listeners.delete(listener); },
}));
const events = vi.hoisted(() => new Set<(event: VarinEvent) => void>());
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: (listener: (event: VarinEvent) => void) => { events.add(listener); return () => events.delete(listener); } }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));
vi.mock('@/components/ui/textarea', () => ({ Textarea: ({ onChange, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} ref={node => { if (node) node.value = String(props.value ?? ''); }} onInput={onChange as React.FormEventHandler<HTMLTextAreaElement>} /> }));
const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread-a', branchId: 'branch-a' };
const other: ThreadIdentity = { ...identity, branchId: 'branch-b' };
const state = (content = '- [ ] Original\nUnparsed notes stay here.', ref = 'p1', selected = identity): ThreadPlanState => ({ identity: selected, headId: 'h1', plan: { ref, threadId: selected.threadId, branchId: selected.branchId, sourceHeadId: 'h1', previousRef: null, content, updatedBy: 'agent', updatedAt: 1 } });
const result = (current: ThreadPlanState): PlanMutationResult => ({ receipt: { threadId: current.identity.threadId, branchId: current.identity.branchId, origin: { kind: 'user', key: 'receipt' }, intentHash: 'hash', status: 'applied', ref: current.plan?.ref ?? null }, plan: current.plan });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  let current = state();
  const read = vi.fn(async (_identity: ThreadIdentity) => current);
  const update = vi.fn(async (input: Parameters<ThreadPlanAPI['update']>[0]) => { current = state(input.content, 'p2'); return result(current); });
  return { api: { read, update }, set: (next: ThreadPlanState) => { current = next; } };
}
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  endpoint.generation = 1;
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); events.clear(); vi.unstubAllGlobals(); });
const render = async (api: ThreadPlanAPI, selected = identity, contextRevision?: number) => { await act(async () => { root.render(<ThreadPlan api={api} identity={selected} contextRevision={contextRevision} />); }); };
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === label)!;
const click = async (label: string) => { await act(async () => { button(label).click(); }); };
const edit = async (value: string) => { await act(async () => { const area = container.querySelector('textarea')!; Object.defineProperty(area, 'value', { configurable: true, writable: true, value }); area.dispatchEvent(new window.Event('input', { bubbles: true })); }); };
const emit = async (event: VarinEvent) => { await act(async () => { for (const listener of events) listener(event); }); };

it('saves raw user content with the observed head and immutable ref CAS, then refreshes the current snapshot', async () => {
  const f = fixture(); await render(f.api); await click('Edit plan');
  expect(container.querySelector('textarea')?.value).toContain('Unparsed notes stay here.');
  const content = '# My own plan\n- [/] Working\nKeep this prose exactly.\n';
  await edit(content); await click('Save plan');
  expect(f.api.update).toHaveBeenCalledWith({ ...identity, key: expect.any(String), expectedHeadId: 'h1', expectedRef: 'p1', content });
  expect(f.api.read).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[aria-label="Current plan"]')?.textContent).toContain(content);
  expect(container.querySelector('textarea')).toBeNull();
});

it('refreshes only matching changes and reconnects without replacing an editing draft or its CAS basis', async () => {
  const f = fixture(); await render(f.api); await click('Edit plan'); await edit('My unsaved draft');
  f.set(state('Agent changed this', 'p2'));
  await emit({ type: 'plan-changed', threadId: identity.threadId, branchId: other.branchId, ref: 'p2' });
  expect(f.api.read).toHaveBeenCalledTimes(1);
  await emit({ type: 'plan-changed', threadId: identity.threadId, branchId: identity.branchId, ref: 'p2' });
  expect(container.querySelector('[aria-label="Current plan"]')?.textContent).toContain('Agent changed this');
  expect(container.querySelector('textarea')?.value).toBe('My unsaved draft');
  await emit({ type: 'stream-ready' });
  expect(f.api.read).toHaveBeenCalledTimes(3);
  await click('Save plan');
  expect(f.api.update.mock.calls[0]![0].expectedRef).toBe('p1');
});

it('keeps the draft on a real 409 and requires an explicit current-revision choice before retrying', async () => {
  const f = fixture(); await render(f.api); await click('Edit plan'); await edit('Retained draft');
  f.set(state('Concurrent agent plan', 'p2'));
  f.api.update.mockRejectedValueOnce(new ThreadRequestError(409, 'plan-conflict'));
  await click('Save plan');
  expect(container.querySelector('textarea')?.value).toBe('Retained draft');
  expect(container.textContent).toContain('Concurrent agent plan');
  expect(button('Save plan').disabled).toBe(true);
  await click('Keep draft against current revision'); await click('Save plan');
  expect(f.api.update.mock.calls[1]![0]).toMatchObject({ expectedRef: 'p2', content: 'Retained draft' });
  expect(f.api.update.mock.calls[1]![0].key).not.toBe(f.api.update.mock.calls[0]![0].key);
});

it('separates missing, empty and failed reads and never edits from a failed read', async () => {
  const f = fixture(); f.set({ identity, headId: null, plan: null }); await render(f.api);
  expect(container.textContent).toContain('No plan yet.'); expect(button('Create plan').disabled).toBe(false);
  f.set(state('', 'empty')); await emit({ type: 'stream-ready' });
  expect(container.textContent).toContain('The plan is empty.'); expect(button('Edit plan').disabled).toBe(false);
  f.api.read.mockRejectedValueOnce(new Error('offline')); await emit({ type: 'stream-ready' });
  expect(container.textContent).toContain('Could not read the current plan.'); expect(button('Edit plan').disabled).toBe(true);
  await click('Retry reading plan'); expect(button('Edit plan').disabled).toBe(false);
});

it('discards old-branch reads and drafts, including reads finishing after the new branch', async () => {
  const f = fixture(); const old = deferred<ThreadPlanState>(); f.api.read.mockReturnValueOnce(old.promise);
  await render(f.api); f.set(state('New branch plan', 'b1', other)); await render(f.api, other);
  await act(async () => { old.resolve(state('Late old plan')); });
  expect(container.textContent).toContain('New branch plan'); expect(container.textContent).not.toContain('Late old plan');
  await click('Edit plan'); await edit('Branch b draft'); f.set(state()); await render(f.api);
  expect(container.querySelector('textarea')).toBeNull(); expect(container.textContent).not.toContain('Branch b draft');
});

it('discards a late old-branch save without clearing the new branch draft or refreshing with its old identity', async () => {
  const f = fixture(); const pending = deferred<PlanMutationResult>(); await render(f.api); await click('Edit plan'); await edit('Old draft');
  f.api.update.mockReturnValueOnce(pending.promise); await click('Save plan');
  expect(container.textContent).toContain('Saving plan…');
  f.set(state('New branch plan', 'b1', other)); await render(f.api, other); await click('Edit plan'); await edit('New draft');
  await act(async () => { pending.resolve(result(state('Old saved plan'))); });
  expect(container.querySelector('textarea')?.value).toBe('New draft');
  expect(f.api.read).toHaveBeenCalledTimes(2);
});

it('reuses an uncertain write identity and does not render an old replay as the current plan', async () => {
  const f = fixture(); await render(f.api); await click('Edit plan'); await edit('My draft');
  f.api.update.mockRejectedValueOnce(new Error('reply lost')); await click('Save plan');
  f.set(state('Newer user plan', 'p3')); f.api.update.mockResolvedValueOnce(result(state('My draft', 'p2')));
  await click('Save plan');
  expect(f.api.update.mock.calls[1]![0]).toEqual(f.api.update.mock.calls[0]![0]);
  expect(container.querySelector('[aria-label="Current plan"]')?.textContent).toBe('Newer user plan');
});

it('clears the draft on a Host switch and rejects an old Host save result', async () => {
  const f = fixture(); const pending = deferred<PlanMutationResult>();
  await render(f.api); await click('Edit plan'); await edit('Old Host draft');
  f.api.update.mockReturnValueOnce(pending.promise); await click('Save plan');
  f.set(state('New Host plan', 'host2'));
  await act(async () => { endpoint.generation += 1; for (const listener of endpoint.listeners) listener(); });
  expect(container.textContent).toContain('New Host plan'); expect(container.querySelector('textarea')).toBeNull();
  await click('Edit plan'); await edit('New Host draft');
  await act(async () => { pending.resolve(result(state('Old Host saved plan'))); });
  expect(container.querySelector('textarea')?.value).toBe('New Host draft');
  expect(f.api.read).toHaveBeenCalledTimes(2);
});

it.each([
  ['plan-not-ready', 'The plan is not ready yet.'],
  ['plan-unsupported', 'Conversation plans are unavailable for this conversation scope.'],
])('distinguishes %s from a missing plan or failed read and refreshes after scope setup', async (code, message) => {
  const f = fixture(); f.api.read.mockRejectedValueOnce(new ThreadRequestError(400, code));
  await render(f.api);
  expect(container.textContent).toContain(message);
  expect(container.textContent).not.toContain('No plan yet.');
  expect(container.textContent).not.toContain('Could not read the current plan.');
  expect(button('Create plan')).toBeUndefined(); expect(button('Retry reading plan')).toBeUndefined();
  expect(f.api.update).not.toHaveBeenCalled();
  f.set({ identity, headId: 'h1', plan: null });
  if (code === 'plan-not-ready') await render(f.api, identity, 1);
  else await emit({ type: 'stream-ready' });
  expect(container.textContent).toContain('No plan yet.'); expect(button('Create plan').disabled).toBe(false);
});

it.each(['plan-not-ready', 'plan-unsupported'])('retains but disables a draft when update reports %s', async code => {
  const f = fixture(); await render(f.api); await click('Edit plan'); await edit('Keep my draft');
  f.api.update.mockRejectedValueOnce(new ThreadRequestError(400, code)); await click('Save plan');
  expect(container.querySelector('textarea')?.value).toBe('Keep my draft');
  expect(container.querySelector('textarea')?.disabled).toBe(true);
  expect(button('Save plan').disabled).toBe(true);
  expect(container.querySelector('[aria-label="Current plan"]')).toBeNull();
  await click('Save plan'); expect(f.api.update).toHaveBeenCalledTimes(1);
});
