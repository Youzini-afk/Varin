import { afterEach, expect, it, vi } from 'vitest';
import type { ThreadIdentity, ThreadSnapshot, ThreadsAPI } from '@varin/application-client';
import { ThreadProjection } from './thread-projection';

const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:projection', branchId: 'branch:projection' };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
afterEach(() => { vi.useRealTimers(); });

it('reconnects from the last durable cursor and replaces lossy progress with authoritative history', async () => {
  vi.useFakeTimers();
  const run = { id: 'run', thread_id: identity.threadId, branch_id: identity.branchId, state: 'generating' as const, revision: 1, epoch: 1, configuration: {}, cancel_requested: false, waiting_on: null };
  const view: ThreadSnapshot = { identity, eventCursor: 6, thread: { thread_id: identity.threadId, observer_project_ids: [null], branches: [{ branch_id: identity.branchId, head: null, active_run_id: run.id, latest_run: run }] }, activeRun: run, history: [], historyPage: { head: null, previous: null }, inputs: [], operations: [], followups: [], launch: null, modelSelection: {desired:null,active:null}, policySelection: null, context: { checkpoint: null, jobs: [] } };
  const connections: Array<{ close(): void; listener: Parameters<ThreadsAPI['observe']>[1] }> = [];
  const observe = vi.fn(async (_cursor: number, listener: Parameters<ThreadsAPI['observe']>[1], { signal }: { signal: AbortSignal }) => {
    const pending = deferred();
    connections.push({ close: pending.resolve, listener });
    signal.addEventListener('abort', pending.resolve, { once: true });
    await pending.promise;
  });
  const snapshot = vi.fn(async () => structuredClone(view));
  const publish = vi.fn(); const progress = vi.fn(); const report = vi.fn();
  const projection = new ThreadProjection({ observe, snapshot } as unknown as ThreadsAPI, identity, publish, report, progress);
  try {
    projection.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(observe.mock.calls[0]![0]).toBe(6);
    connections[0]!.listener({ cursor: 7, subject: run.id, revision: 1, kind: 'run.changed', data: {} });
    await vi.advanceTimersByTimeAsync(0);
    connections[0]!.listener({ v: 1, kind: 'runtime-event', kernelEpoch: 'epoch', stream: 'progress', runId: run.id, streamId: 'first-stream', sequence: 1, event: { kind: 'provider', data: { kind: 'text_delta', item_id: 'assistant', text: 'unfinished display text' } } });
    expect(progress).toHaveBeenLastCalledWith('unfinished display text');
    connections[0]!.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(progress).toHaveBeenLastCalledWith('');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(observe.mock.calls[1]![0]).toBe(7);
    view.history.push({ id: 'committed-message', thread_id: identity.threadId, parent: null, source: 'assistant', content: { text: 'durable answer' }, provider: null });
    connections[1]!.listener({ cursor: 8, subject: run.id, revision: 2, kind: 'history.appended', data: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(publish.mock.calls.at(-1)![0].history[0].content.text).toBe('durable answer');
    expect(progress).toHaveBeenLastCalledWith('');
    expect(report).not.toHaveBeenCalled();
  } finally { projection.close(); await vi.advanceTimersByTimeAsync(0); }
});
