import { afterEach, expect, it, vi } from 'vitest';
import type { ThreadIdentity, ThreadSnapshot, ThreadsAPI } from '@varin/application-client';
import { KERNEL_PROTOCOL_VERSION } from '../../../../web/application-host/lib/kernel/protocol.generated.js';
import { ThreadProjection, type StreamingTextPart } from './thread-projection';

const textOf = (parts: StreamingTextPart[]) => parts.map(part => part.type === 'text' ? part.text : part.thinking).join('\n');

const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:projection', branchId: 'branch:projection' };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
afterEach(() => { vi.useRealTimers(); });

it('reconnects from the last durable cursor and replaces lossy progress with authoritative history', async () => {
  vi.useFakeTimers();
  const run = { id: 'run', thread_id: identity.threadId, branch_id: identity.branchId, state: 'generating' as const, revision: 1, epoch: 1, configuration: {}, cancel_requested: false, waiting_on: null };
  const view: ThreadSnapshot = { identity, eventCursor: 6, thread: { thread_id: identity.threadId, main_branch_id: identity.branchId, title: '', revision: 1, created_at_ms: 0, updated_at_ms: 0, pinned: false, archived: false, deleted_at_ms: null, activity_cursor: 0, read_cursor: 0, unread: false, bot_id: null, parent_thread_id: null, observer_project_ids: [null], branches: [{ branch_id: identity.branchId, head: null, active_run_id: run.id, latest_run: run }] }, activeRun: run, history: [], historyPage: { head: null, previous: null }, inputs: [], operations: [], followups: [], goals: [], launch: null, modelSelection: {desired:null,active:null}, policySelection: null, context: { checkpoint: null, jobs: [] } };
  const connections: Array<{ close(): void; listener: Parameters<ThreadsAPI['observe']>[1] }> = [];
  const observe = vi.fn(async (_cursor: number, listener: Parameters<ThreadsAPI['observe']>[1], { signal }: { signal: AbortSignal }) => {
    const pending = deferred();
    connections.push({ close: pending.resolve, listener });
    signal.addEventListener('abort', pending.resolve, { once: true });
    await pending.promise;
  });
  const snapshot = vi.fn(async () => structuredClone(view));
  const publish = vi.fn(); const progress = vi.fn(); const report = vi.fn();
  const projection = new ThreadProjection({ observe, snapshot } as unknown as ThreadsAPI, identity, publish, report, parts => progress(textOf(parts)));
  try {
    projection.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(observe.mock.calls[0]![0]).toBeNull();
    connections[0]!.listener({ cursor: 7, subject: run.id, revision: 1, kind: 'run.changed', data: {} });
    await vi.advanceTimersByTimeAsync(0);
    connections[0]!.listener(delta(1, 'unfinished display text'));
    expect(progress).toHaveBeenLastCalledWith('unfinished display text');
    connections[0]!.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(progress).toHaveBeenLastCalledWith('');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(observe.mock.calls[1]![0]).toBe(7);
    view.history.push({ id: 'committed-message', thread_id: identity.threadId, run_id: 'ui-run', parent: null, source: 'assistant', content: { text: 'durable answer' }, provider: null });
    connections[1]!.listener({ cursor: 8, subject: run.id, revision: 2, kind: 'history.appended', data: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(publish.mock.calls.at(-1)![0].history[0].content.text).toBe('durable answer');
    expect(progress).toHaveBeenLastCalledWith('');
    expect(report).not.toHaveBeenCalled();
  } finally { projection.close(); await vi.advanceTimersByTimeAsync(0); }
});

function snapshotView(active = true): ThreadSnapshot {
  const run = { id: 'run', thread_id: identity.threadId, branch_id: identity.branchId, state: 'generating' as const, revision: 1, epoch: 1, configuration: {}, cancel_requested: false, waiting_on: null };
  return { identity, eventCursor: 6, thread: { thread_id: identity.threadId, main_branch_id: identity.branchId, title: '', revision: 1, created_at_ms: 0, updated_at_ms: 0, pinned: false, archived: false, deleted_at_ms: null, activity_cursor: 0, read_cursor: 0, unread: false, bot_id: null, parent_thread_id: null, observer_project_ids: [null], branches: [{ branch_id: identity.branchId, head: null, active_run_id: active ? run.id : null, latest_run: active ? run : null }] }, activeRun: active ? run : null, history: [], historyPage: { head: null, previous: null }, inputs: [], operations: [], followups: [], goals: [], launch: null, modelSelection: { desired: null, active: null }, policySelection: null, context: { checkpoint: null, jobs: [] } };
}
function delta(sequence: number, text: string, runId = 'run', requestId = 'request') {
  return { v: KERNEL_PROTOCOL_VERSION, kind: 'runtime-event' as const, kernelEpoch: 'epoch', stream: 'progress' as const, runId,
    threadId: runId === 'run' ? identity.threadId : 'other-thread', branchId: identity.branchId, requestId,
    streamId: `stream:${runId}`, sequence, event: { kind: 'batch', events: [{ kind: 'provider', data: { kind: 'text_delta', item_id: 'assistant', text } }] } };
}
async function startProjection(snapshot: ThreadsAPI['snapshot']) {
  vi.useFakeTimers();
  let listener!: Parameters<ThreadsAPI['observe']>[1];
  const observe: ThreadsAPI['observe'] = async (_cursor, next, { signal }) => {
    listener = next;
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  };
  const progress = vi.fn(); const parts = vi.fn(); const report = vi.fn(); const publish = vi.fn();
  const projection = new ThreadProjection({ snapshot, observe } as ThreadsAPI, identity, publish, report, value => { parts(value); progress(textOf(value)); });
  projection.start();
  await vi.advanceTimersByTimeAsync(0);
  return { projection, listener, progress, parts, report, publish };
}

it('streams thinking and text during the initial snapshot and keeps the next request when old history commits', async () => {
  const pending = deferred();
  const view = snapshotView();
  const snapshot = vi.fn<ThreadsAPI['snapshot']>().mockImplementationOnce(async () => { await pending.promise; return snapshotView(false); })
    .mockImplementation(async () => structuredClone(view));
  const h = await startProjection(snapshot);
  try {
    const event = delta(1, 'First answer');
    event.event.events.unshift({ kind: 'provider', data: { kind: 'reasoning_delta', item_id: 'reasoning', text: 'Visible thinking' } });
    h.listener(event);
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.parts).toHaveBeenLastCalledWith([{ type: 'thinking', thinking: 'Visible thinking' }, { type: 'text', text: 'First answer' }]);
    pending.resolve(); await vi.advanceTimersByTimeAsync(0);
    h.listener(delta(2, 'Next answer', 'run', 'next-request'));
    view.history.push({ id: 'old-answer', thread_id: identity.threadId, run_id: 'run', parent: null, source: 'assistant',
      content: { id: 'model-item:7:requestanswer', content: { kind: 'text', text: 'First answer' } }, provider: null });
    h.listener({ cursor: 8, subject: 'run', revision: 2, kind: 'history.appended', data: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.parts).toHaveBeenLastCalledWith([{ type: 'text', text: 'Next answer' }]);
  } finally { pending.resolve(); h.projection.close(); }
});

it('retains the first chunks while the accepted Run snapshot is in flight', async () => {
  const pending = deferred();
  const snapshot = vi.fn<ThreadsAPI['snapshot']>().mockResolvedValueOnce(snapshotView(false))
    .mockImplementationOnce(async () => { await pending.promise; return snapshotView(); })
    .mockResolvedValue(snapshotView());
  const h = await startProjection(snapshot);
  try {
    h.listener({ cursor: 7, subject: 'run', revision: 1, kind: 'run.accepted', data: {} });
    h.listener(delta(1, 'Controlled Q'));
    expect(h.progress).toHaveBeenLastCalledWith('Controlled Q');
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.progress).toHaveBeenLastCalledWith('Controlled Q');
    h.listener(delta(2, 'A response in progress.'));
    expect(h.progress).toHaveBeenLastCalledWith('Controlled QA response in progress.');
    expect(h.report).not.toHaveBeenCalled();
  } finally { h.projection.close(); }
});

it('keeps an unconfirmed prefix through a snapshot that started before the Run became active', async () => {
  const pending = deferred();
  const snapshot = vi.fn<ThreadsAPI['snapshot']>().mockResolvedValueOnce(snapshotView(false))
    .mockImplementationOnce(async () => { await pending.promise; return snapshotView(false); })
    .mockResolvedValue(snapshotView());
  const h = await startProjection(snapshot);
  try {
    h.listener({ cursor: 7, subject: 'unrelated', revision: 1, kind: 'run.changed', data: {} });
    h.listener(delta(1, 'Controlled Q'));
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.progress).toHaveBeenLastCalledWith('Controlled Q');
    expect(h.report).not.toHaveBeenCalled();
  } finally { h.projection.close(); }
});

it('preserves live text when user history arrives and replaces it when assistant history commits', async () => {
  const view = snapshotView();
  const h = await startProjection(async () => structuredClone(view));
  try {
    h.listener(delta(1, 'Controlled Q'));
    view.history.push({ id: 'user', thread_id: identity.threadId, run_id: 'run', parent: null, source: 'user', content: { text: 'Question' }, provider: null });
    h.listener({ cursor: 7, subject: 'run', revision: 1, kind: 'input.delivered', data: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.progress).toHaveBeenLastCalledWith('Controlled Q');
    h.listener(delta(2, 'A response.'));
    expect(h.progress).toHaveBeenLastCalledWith('Controlled QA response.');
    view.history.push({ id: 'answer', thread_id: identity.threadId, run_id: 'run', parent: 'user', source: 'assistant', content: { id: 'model-item:7:requestanswer', text: 'Controlled QA response.' }, provider: null });
    h.listener({ cursor: 8, subject: 'run', revision: 2, kind: 'execution.committed', data: { kind: 'model_finished' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.progress).toHaveBeenLastCalledWith('');
    expect(h.publish.mock.calls.at(-1)![0].history.at(-1).id).toBe('answer');
  } finally { h.projection.close(); }
});

it('publishes scoped progress while a snapshot is pending and ignores other threads and closed views', async () => {
  const pending = deferred();
  const snapshot = vi.fn<ThreadsAPI['snapshot']>().mockResolvedValueOnce(snapshotView(false))
    .mockImplementationOnce(async () => { await pending.promise; return snapshotView(); });
  const h = await startProjection(snapshot);
  h.listener(delta(1, 'Other thread text', 'other-run'));
  h.listener(delta(1, 'Unconfirmed current text'));
  h.projection.close();
  pending.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.progress).toHaveBeenLastCalledWith('Unconfirmed current text');
  expect(h.progress).not.toHaveBeenCalledWith('Other thread text');
  expect(h.publish).toHaveBeenCalledTimes(1);
});

it('discards other Threads\' progress after resolving current ownership and clears a finished Run', async () => {
  let view = snapshotView();
  const h = await startProjection(async () => structuredClone(view));
  try {
    h.listener(delta(1, 'Current text'));
    h.listener(delta(1, 'Other text', 'other-run'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.progress).toHaveBeenLastCalledWith('Current text');
    expect(h.progress).not.toHaveBeenCalledWith('Other text');
    view = snapshotView(false);
    h.listener({ cursor: 7, subject: 'run', revision: 2, kind: 'execution.committed', data: { kind: 'state_changed' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.progress).toHaveBeenLastCalledWith('');
  } finally { h.projection.close(); }
});
