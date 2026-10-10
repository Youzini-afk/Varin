import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThreadRequestError } from '@varin/application-client';
import type { ThreadGoalsAPI, ThreadIdentity } from '@varin/application-client';
import type { Goal, GoalControlReceipt, GoalMeasuredUsage } from '@varin/protocol';
import { ThreadGoal } from './ThreadGoal';

const endpoint = vi.hoisted(() => ({ generation: 1, listeners: new Set<() => void>() }));
vi.mock('@varin/application-client', async importOriginal => ({
  ...await importOriginal<typeof import('@varin/application-client')>(),
  getRuntimeEndpointGeneration: () => endpoint.generation,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { endpoint.listeners.add(listener); return () => endpoint.listeners.delete(listener); },
}));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));
vi.mock('@/components/ui/textarea', () => ({ Textarea: ({ onChange, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} ref={node => { if (node) node.value = String(props.value ?? ''); }} onInput={onChange as React.FormEventHandler<HTMLTextAreaElement>} /> }));
const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread-a', branchId: 'branch-a' };
const measured = (): GoalMeasuredUsage => ({ inferences: 0, input_tokens: { known: 0, unknown_receipts: 0 }, output_tokens: { known: 0, unknown_receipts: 0 }, cached_input_tokens: { known: 0, unknown_receipts: 0 }, cache_write_tokens: { known: 0, unknown_receipts: 0 }, reasoning_tokens: { known: 0, unknown_receipts: 0 } });
const goal = (patch: Partial<Goal> = {}): Goal => ({ id: 'goal-a', revision: 1, generation: 1, thread_id: identity.threadId, branch_id: identity.branchId, source_run_id: 'latest-finished-run', objective: 'Keep working on the result', control: 'active', state: 'active', budget: null, usage: { actual: measured(), estimated: measured(), missing_inferences: 0, pending_inferences: 0 }, blocked_reason: null, reason: null, dependency_operation_id: null, ...patch });
const receipt = (value: Goal): GoalControlReceipt => ({ id: value.id, revision: value.revision, generation: value.generation, thread_id: value.thread_id, branch_id: value.branch_id, control: value.control });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  endpoint.generation = 1;
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === label)!;
const click = async (label: string) => { await act(async () => { button(label).click(); }); };
const edit = async (label: string, value: string) => { await act(async () => {
  const input = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  Object.defineProperty(input, 'value', { configurable: true, writable: true, value });
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}); };
function fixture(initial = [goal()]) {
  let values = initial;
  let selected = identity;
  let run: string | undefined = 'latest-finished-run';
  const list = vi.fn(async () => structuredClone(values));
  const start = vi.fn<ThreadGoalsAPI['start']>(async input => {
    const created = goal({ id: input.key, source_run_id: input.runId, objective: input.objective, budget: input.budget }); values = [...values, created]; return receipt(created);
  });
  const update = vi.fn<ThreadGoalsAPI['update']>(async input => {
    const old = values.find(value => value.id === input.goalId)!;
    if (input.expectedRevision !== old.revision) throw new ThreadRequestError(409, 'goal-conflict');
    const next = { ...old, objective: input.objective, budget: input.budget, revision: old.revision + 1 }; values = values.map(value => value.id === next.id ? next : value); return receipt(next);
  });
  const control = vi.fn<ThreadGoalsAPI['control']>(async input => {
    const old = values.find(value => value.id === input.goalId)!;
    if (input.expectedRevision !== old.revision) throw new ThreadRequestError(409, 'goal-conflict');
    const next = { ...old, control: ({ pause: 'paused', resume: 'active', complete: 'complete', cancel: 'cancelled' } as const)[input.action], revision: old.revision + 1 };
    values = [{ ...next, state: next.control }]; return receipt(next);
  });
  const api = { list, start, update, control };
  const draw = () => root.render(<ThreadGoal api={api} identity={selected} goals={structuredClone(values)} sourceRunId={run} refresh={refresh} />);
  const refresh = vi.fn(async () => { draw(); });
  return { api, refresh, set: (next: Goal[]) => { values = next; }, render: async (nextIdentity = identity, source: string | undefined = 'latest-finished-run') => {
    selected = nextIdentity; run = source; await act(async () => { draw(); });
  }, noRun: async () => { run = undefined; await act(async () => { draw(); }); } };
}

it('keeps one start intent through an unknown outcome and accepts a zero output budget on a finished source run', async () => {
  const f = fixture([]); await f.render(); await click('Create goal'); await edit('New goal objective', 'Finish this exact objective'); await edit('New goal output-token budget', '0');
  f.api.start.mockRejectedValueOnce(new Error('reply lost')); await click('Start goal');
  expect(f.api.start.mock.calls[0]![0]).toMatchObject({ ...identity, runId: 'latest-finished-run', objective: 'Finish this exact objective', budget: { maxOutputTokens: 0 } });
  expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(true);
  expect(button('Discard new goal draft').disabled).toBe(true);
  await click('Retry starting same goal');
  expect(f.api.start.mock.calls[1]![0]).toEqual(f.api.start.mock.calls[0]![0]);
  expect(container.querySelector('[aria-label="Current goal objective"]')?.textContent).toBe('Finish this exact objective');
  expect(container.querySelector('textarea')).toBeNull();
});

it('retains a new draft without inventing a source run and validates only exact non-negative integer budgets', async () => {
  const f = fixture([]); await f.noRun(); await click('Create goal'); await edit('New goal objective', 'Continue once work exists');
  expect(button('Start goal').disabled).toBe(true);
  expect(container.textContent).toContain('Send a message first');
  await f.render(); await edit('New goal output-token budget', '-1');
  expect(button('Start goal').disabled).toBe(true);
  await edit('New goal output-token budget', '9007199254740992'); expect(button('Start goal').disabled).toBe(true);
  await edit('New goal output-token budget', '9876543210'); await click('Start goal');
  expect(f.api.start.mock.calls[0]![0].budget).toEqual({ maxOutputTokens: 9876543210 });
});

it('keeps an editing draft and frozen revision across authoritative refresh, conflict and explicit rebase', async () => {
  const f = fixture(); await f.render(); await click('Edit goal'); await edit('Edit goal objective', 'My unsaved objective');
  f.set([goal({ revision: 2, objective: 'Concurrent objective', budget: { maxOutputTokens: 25 } })]); await act(async () => { await f.refresh(); });
  expect(container.querySelector('textarea')?.value).toBe('My unsaved objective');
  expect(container.textContent).toContain('Editing revision 1.');
  await click('Save goal');
  expect(f.api.update.mock.calls[0]![0].expectedRevision).toBe(1);
  expect(f.api.list).toHaveBeenCalledOnce(); expect(button('Save goal').disabled).toBe(true);
  expect(container.textContent).toContain('Latest read: revision 2');
  await click('Keep draft against current revision'); await click('Save goal');
  expect(f.api.update.mock.calls[1]![0]).toMatchObject({ expectedRevision: 2, objective: 'My unsaved objective', budget: null });
});

it('rereads an uncertain CAS write, preserves its draft and does not silently retry at a newer revision', async () => {
  const f = fixture(); await f.render(); await click('Edit goal'); await edit('Edit goal objective', 'Maybe saved');
  f.set([goal({ revision: 2, objective: 'Maybe saved' })]);
  f.api.update.mockRejectedValueOnce(new Error('reply lost')); f.api.list.mockRejectedValueOnce(new Error('offline')); await click('Save goal');
  expect(container.querySelector('textarea')?.value).toBe('Maybe saved');
  expect(container.textContent).toContain('Editing revision 1.');
  expect(button('Save goal').disabled).toBe(true); expect(button('Keep draft against current revision')).toBeUndefined();
  await click('Read current goal again'); expect(f.api.update).toHaveBeenCalledOnce();
  await click('Keep draft against current revision'); await click('Save goal');
  expect(f.api.update.mock.calls[1]![0].expectedRevision).toBe(2);
});

it('requires an explicit current-revision control after unknown outcome and retains ended goals when starting new work', async () => {
  const f = fixture(); await f.render();
  f.api.control.mockRejectedValueOnce(new Error('reply lost'));
  f.set([goal({ revision: 2, control: 'paused', state: 'paused' })]); await click('Pause goal');
  expect(f.api.control.mock.calls[0]![0]).toMatchObject({ action: 'pause', expectedRevision: 1 });
  expect(f.api.control).toHaveBeenCalledOnce(); expect(container.textContent).toContain('Latest read: revision 2');
  await click('Apply pause at revision 2'); expect(f.api.control.mock.calls[1]![0].expectedRevision).toBe(2);
  await click('Complete goal');
  expect(container.querySelector('[aria-label="Past goal"]')).not.toBeNull();
  expect(button('Create goal').disabled).toBe(false); await click('Create goal'); await edit('New goal objective', 'A new continuation'); await click('Start goal');
  expect(container.querySelectorAll('[aria-label="Past goal"]')).toHaveLength(1);
  expect(container.querySelector('[aria-label="Current goal objective"]')?.textContent).toContain('Keep working');
  expect(container.textContent).toContain('A new continuation');
});

it('displays unknown, estimated and pending usage separately and keeps real blocker details while paused', async () => {
  const value = goal({ control: 'paused', state: 'paused', blocked_reason: 'dependency', reason: 'Waiting for experiment output', dependency_operation_id: 'operation-original', budget: { maxOutputTokens: 10 } });
  value.usage.actual.output_tokens = { known: 12, unknown_receipts: 2 }; value.usage.actual.input_tokens = { known: 40, unknown_receipts: 1 };
  value.usage.estimated.output_tokens = { known: 7, unknown_receipts: 3 }; value.usage.missing_inferences = 4; value.usage.pending_inferences = 5;
  const f = fixture([value]); await f.render();
  expect(container.textContent).toContain('Paused'); expect(container.textContent).toContain('Waiting for experiment output'); expect(container.textContent).toContain('operation-original');
  expect(container.textContent).toContain('Reported output: 12 known tokens · 2 unknown receipts');
  expect(container.textContent).toContain('Estimated output (separate): 7 known tokens · 3 unknown receipts');
  expect(container.textContent).toContain('4 missing usage receipts · 5 pending inferences');
  expect(container.textContent).toContain('In-flight work can exceed it');
  await click('Resume goal'); expect(f.api.control.mock.calls[0]![0]).toMatchObject({ action: 'resume', expectedRevision: 1 });
});

it('uses only refreshed authority after a short receipt and ignores old-branch or old-Host async writes', async () => {
  const f = fixture(); const first = deferred<GoalControlReceipt>();
  await f.render(); await click('Edit goal'); await edit('Edit goal objective', 'Old branch draft'); f.api.update.mockReturnValueOnce(first.promise); await click('Save goal');
  const other = { ...identity, branchId: 'branch-b' }; f.set([goal({ branch_id: other.branchId, objective: 'Other branch' })]); await f.render(other);
  await click('Edit goal'); await edit('Edit goal objective', 'New branch draft');
  await act(async () => { first.resolve(receipt(goal({ revision: 2 }))); });
  expect(container.querySelector('textarea')?.value).toBe('New branch draft'); expect(f.refresh).not.toHaveBeenCalled();
  const second = deferred<GoalControlReceipt>(); f.api.update.mockReturnValueOnce(second.promise); await click('Save goal');
  f.set([goal({ branch_id: other.branchId, objective: 'New Host goal' })]);
  await act(async () => { endpoint.generation += 1; for (const listener of endpoint.listeners) listener(); });
  await f.render(other); await click('Edit goal'); await edit('Edit goal objective', 'New Host draft');
  await act(async () => { second.resolve(receipt(goal({ revision: 3 }))); });
  expect(container.querySelector('textarea')?.value).toBe('New Host draft'); expect(f.refresh).not.toHaveBeenCalled();
  f.set([goal({ branch_id: other.branchId, revision: 5, objective: 'Later authoritative objective' })]); f.api.update.mockResolvedValueOnce(receipt(goal({ revision: 2 })));
  f.refresh.mockRejectedValueOnce(new Error('Conversation refresh failed after the accepted write'));
  await click('Save goal'); expect(container.querySelector('[aria-label="Current goal objective"]')?.textContent).toBe('Later authoritative objective');
  expect(container.textContent).toContain('The Goal change was accepted');
  expect(container.textContent).not.toContain('Could not confirm the change');
});

it('waits for the authoritative Goal after an accepted start receipt instead of offering another creation', async () => {
  const f = fixture([]); await f.render(); await click('Create goal'); await edit('New goal objective', 'Wait for the current view');
  f.api.start.mockImplementationOnce(async input => receipt(goal({ id: input.key, objective: input.objective })));
  f.refresh.mockRejectedValueOnce(new Error('Conversation refresh failed after the accepted start'));
  await click('Start goal');
  expect(container.textContent).toContain('Goal creation was accepted.');
  expect(container.textContent).not.toContain('Could not confirm goal creation');
  expect(button('Start goal')).toBeUndefined(); expect(button('Discard new goal draft').disabled).toBe(true);
  const request = f.api.start.mock.calls[0]![0]; f.set([goal({ id: request.key, revision: 3, objective: 'Newer authoritative objective' })]);
  await click('Refresh current goals');
  expect(container.querySelector('textarea')).toBeNull();
  expect(container.querySelector('[aria-label="Current goal objective"]')?.textContent).toBe('Newer authoritative objective');
  expect(f.api.start).toHaveBeenCalledOnce();
});
