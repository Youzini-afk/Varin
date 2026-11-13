import { afterEach, expect, it, vi } from 'vitest';
import type { ThreadIdentity, ThreadSnapshot, ThreadsAPI } from '@varin/application-client';
import { KERNEL_PROTOCOL_VERSION } from '../../../../web/application-host/lib/kernel/protocol.generated.js';
import { ThreadProjection, type StreamingTextPart } from './thread-projection';
import { ThreadHistoryWindow } from './thread-history';

const textOf = (parts: StreamingTextPart[]) => parts.map(part => part.type === 'text' ? part.text : part.type === 'thinking' ? part.thinking : '').join('\n');

const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:projection', branchId: 'branch:projection' };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
afterEach(() => { vi.useRealTimers(); });

it('cancels an unfinished snapshot when leaving a conversation without reporting a load failure', async () => {
  vi.useFakeTimers();
  let reading: AbortSignal | undefined;
  const snapshot: ThreadsAPI['snapshot'] = async (_identity, signal) => {
    reading = signal;
    return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const f = await startProjection(snapshot);
  expect(reading).toBeInstanceOf(AbortSignal);
  expect(reading?.aborted).toBe(false);
  f.projection.close();
  await vi.advanceTimersByTimeAsync(0);
  expect(reading?.aborted).toBe(true);
  expect(f.report).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
});

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
    connections[0]!.listener({ cursor: 7, thread_id: identity.threadId, branch_id: identity.branchId, subject: run.id, revision: 1, kind: 'run.changed', data: {} });
    await vi.advanceTimersByTimeAsync(0);
    connections[0]!.listener(delta(1, 'unfinished display text'));
    expect(progress).toHaveBeenLastCalledWith('unfinished display text');
    connections[0]!.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(progress).toHaveBeenLastCalledWith('');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(observe.mock.calls[1]![0]).toBe(7);
    view.history.push({ id: 'committed-message', thread_id: identity.threadId, run_id: 'ui-run', parent: null, source: 'assistant', content: { text: 'durable answer' }, provider: null });
    connections[1]!.listener({ cursor: 8, thread_id: identity.threadId, branch_id: identity.branchId, subject: run.id, revision: 2, kind: 'history.appended', data: {} });
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
  const progress = vi.fn(); const parts = vi.fn(); const report = vi.fn(); const publish = vi.fn(); const tools = vi.fn();
  const toolProgress = vi.fn();
  const projection = new ThreadProjection({ snapshot, observe } as ThreadsAPI, identity, publish, report, value => { parts(value); progress(textOf(value)); }, tools, toolProgress);
  projection.start();
  await vi.advanceTimersByTimeAsync(0);
  return { projection, listener, progress, parts, report, publish, tools, toolProgress };
}

it('shows retry waiting separately and replaces it when the next attempt starts', async () => {
  const view = snapshotView();
  const h = await startProjection(async () => structuredClone(view));
  try {
    h.listener(delta(1, 'unfinished'));
    h.listener({ ...delta(2, ''), event: { kind: 'batch', events: [{ kind: 'retry_scheduled', data: { attempt: 1, delay_ms: 5000 } }] } });
    expect(h.parts.mock.lastCall?.[0]).toMatchObject([{ type: 'text', text: 'unfinished' }, { type: 'retry', attempt: 1 }]);
    h.listener(delta(3, 'fresh answer', 'run', 'request:retry:1'));
    expect(h.parts.mock.lastCall?.[0]).toEqual([{ type: 'text', id: 'model-item:15:request:retry:1:assistant', order: 0, text: 'fresh answer' }]);
  } finally { h.projection.close(); }
});

it('keeps retrieval progress after the model call commits and ends it at the tool receipt', async () => {
  const view = snapshotView();
  view.history.push({ id: 'call-history', thread_id: identity.threadId, run_id: 'run', parent: null, source: 'assistant',
    content: { id: 'model-item:7:request:call', content: { kind: 'tool_call', call: { call_id: 'call', name: 'code_retrieval', arguments: {} } } }, provider: null });
  const h = await startProjection(async () => structuredClone(view));
  const update = (sequence: number) => ({ ...delta(sequence, ''), streamId: 'retrieval', event: {
    kind: 'tool_progress', operationId: 'request:tool:call', toolName: 'code_retrieval', details: { progress: { phase: 'collecting', receivedFiles: sequence } },
  } });
  try {
    h.listener(update(1)); h.listener(update(3)); h.listener(update(2));
    expect(h.toolProgress).toHaveBeenCalledTimes(2);
    expect(h.toolProgress.mock.lastCall?.[0]).toMatchObject([{ operationId: 'request:tool:call', details: { progress: { receivedFiles: 3 } } }]);
    expect(h.progress).toHaveBeenLastCalledWith('');
    view.history.push({ id: 'receipt', thread_id: identity.threadId, run_id: 'run', parent: 'call-history', source: 'tool', provider: null,
      content: { content: { kind: 'tool_result', result: { request_id: 'request', call_id: 'call', completion: {} } } } });
    h.listener({ cursor: 7, thread_id: identity.threadId, branch_id: identity.branchId, subject: 'run', revision: 2, kind: 'history.appended', data: {} });
    await vi.advanceTimersByTimeAsync(0);
    h.listener(update(4));
    expect(h.toolProgress).toHaveBeenCalledTimes(2);
    expect(view.operations).toEqual([]);
  } finally { h.projection.close(); }
});

it('exposes a gateway render_ui call while its HTML is still streaming and retains the original call identity', async () => {
  const h = await startProjection(async () => snapshotView());
  const send = (sequence: number, data: object) => h.listener({ ...delta(sequence, ''),
    event: { kind: 'batch', events: [{ kind: 'provider', data }] } });
  try {
    send(1, { kind: 'tool_call_started', request_id: 'request', call_id: 'call', name: 'tool_invoke' });
    const first = '{"reference":{"name":"render_ui","version":"1"},"arguments":{"ref":"ui:work@1","changes":[{"file":"index.html","op":"write","text":"<h1>生成中';
    send(2, { kind: 'tool_arguments_delta', call_id: 'call', delta: first });
    expect(h.tools).toHaveBeenLastCalledWith([expect.objectContaining({ id: JSON.stringify(['run', 'request', 'call']), name: 'render_ui', rawArguments: first, sequence: 2, reference: 'ui:work@1' })]);
    send(3, { kind: 'tool_arguments_delta', call_id: 'call', delta: '</h1>"}]}}' });
    expect(h.tools.mock.lastCall?.[0][0]).toMatchObject({ name: 'render_ui', reference: 'ui:work@1', rawArguments: first + '</h1>"}]}}' });
  } finally { h.projection.close(); }
});

it('presents streamed tool intent without publishing an incomplete file path', async () => {
  const h = await startProjection(async () => snapshotView());
  const send = (sequence: number, data: object) => h.listener({ ...delta(sequence, ''), event: { kind: 'batch', events: [{ kind: 'provider', data }] } });
  try {
    send(1, { kind: 'tool_call_started', request_id: 'request', call_id: 'read', name: 'tool_invoke' });
    send(2, { kind: 'tool_arguments_delta', call_id: 'read', delta: '{"reference":{"name":"file_read"},"arguments":{"path":"src/unfin' });
    expect(h.tools.mock.lastCall?.[0][0]).toMatchObject({ name: 'file_read', arguments: {}, gateway: { name: 'tool_invoke' } });
    send(3, { kind: 'tool_arguments_delta', call_id: 'read', delta: 'ished.ts","offset":0}}' });
    expect(h.tools.mock.lastCall?.[0][0]).toMatchObject({ id: JSON.stringify(['run', 'request', 'read']), name: 'file_read', arguments: { path: 'src/unfinished.ts', offset: 0 } });
    expect(h.report).not.toHaveBeenCalled();
  } finally { h.projection.close(); }
});

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
    expect(h.parts).toHaveBeenLastCalledWith([
      { type: 'thinking', id: 'model-item:7:request:reasoning', order: 0, thinking: 'Visible thinking' },
      { type: 'text', id: 'model-item:7:request:assistant', order: 1, text: 'First answer' },
    ]);
    pending.resolve(); await vi.advanceTimersByTimeAsync(0);
    h.listener(delta(2, 'Next answer', 'run', 'next-request'));
    view.history.push({ id: 'old-answer', thread_id: identity.threadId, run_id: 'run', parent: null, source: 'assistant',
      content: { id: 'model-item:7:requestanswer', content: { kind: 'text', text: 'First answer' } }, provider: null });
    h.listener({ cursor: 8, thread_id: identity.threadId, branch_id: identity.branchId, subject: 'run', revision: 2, kind: 'history.appended', data: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.parts).toHaveBeenLastCalledWith([{ type: 'text', id: 'model-item:12:next-request:assistant', order: 0, text: 'Next answer' }]);
  } finally { pending.resolve(); h.projection.close(); }
});

it('retains the first chunks while the accepted Run snapshot is in flight', async () => {
  const pending = deferred();
  const snapshot = vi.fn<ThreadsAPI['snapshot']>().mockResolvedValueOnce(snapshotView(false))
    .mockImplementationOnce(async () => { await pending.promise; return snapshotView(); })
    .mockResolvedValue(snapshotView());
  const h = await startProjection(snapshot);
  try {
    h.listener({ cursor: 7, thread_id: identity.threadId, branch_id: identity.branchId, subject: 'run', revision: 1, kind: 'run.accepted', data: {} });
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
    h.listener({ cursor: 7, thread_id: identity.threadId, branch_id: identity.branchId, subject: 'unrelated', revision: 1, kind: 'run.changed', data: {} });
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
    h.listener({ cursor: 7, thread_id: identity.threadId, branch_id: identity.branchId, subject: 'run', revision: 1, kind: 'input.delivered', data: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.progress).toHaveBeenLastCalledWith('Controlled Q');
    h.listener(delta(2, 'A response.'));
    expect(h.progress).toHaveBeenLastCalledWith('Controlled QA response.');
    view.history.push({ id: 'answer', thread_id: identity.threadId, run_id: 'run', parent: 'user', source: 'assistant', content: { id: 'model-item:7:requestanswer', text: 'Controlled QA response.' }, provider: null });
    h.listener({ cursor: 8, thread_id: identity.threadId, branch_id: identity.branchId, subject: 'run', revision: 2, kind: 'execution.committed', data: { kind: 'model_finished' } });
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
    h.listener({ cursor: 7, thread_id: identity.threadId, branch_id: identity.branchId, subject: 'run', revision: 2, kind: 'execution.committed', data: { kind: 'state_changed' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.progress).toHaveBeenLastCalledWith('');
  } finally { h.projection.close(); }
});

it('does no snapshot or context work for other threads and read markers; coalesces this thread while a read is pending', async () => {
  const view = snapshotView(), pending = deferred();
  const snapshot = vi.fn<ThreadsAPI['snapshot']>().mockResolvedValueOnce(view)
    .mockImplementationOnce(async () => { await pending.promise; return structuredClone(view); }).mockResolvedValue(view);
  const h = await startProjection(snapshot);
  try {
    for (let cursor = 7; cursor < 107; cursor++) h.listener({ cursor, thread_id: 'background-bot', branch_id: 'background', subject: 'background-run', revision: cursor, kind: 'run.changed', data: {} });
    h.listener({ cursor: 107, thread_id: identity.threadId, branch_id: identity.branchId, subject: identity.threadId, revision: 2, kind: 'thread.read', data: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot).toHaveBeenCalledTimes(1);
    for (let cursor = 108; cursor < 208; cursor++) h.listener({ cursor, thread_id: identity.threadId, branch_id: identity.branchId, subject: 'run', revision: cursor, kind: 'run.changed', data: {} });
    expect(snapshot).toHaveBeenCalledTimes(2);
    pending.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(snapshot).toHaveBeenCalledTimes(3);
  } finally { h.projection.close(); }
});

it('merges verified history deltas with stable old entities and replaces the cut on reset', async () => {
  const first = snapshotView();
  first.history = [{ id: 'old', thread_id: identity.threadId, run_id: 'run', parent: null, source: 'user', content: { text: 'old prompt' }, provider: null }];
  first.historyPage = { head: 'old', previous: null };
  const next = structuredClone(first);
  next.history = [{ id: 'new', thread_id: identity.threadId, run_id: 'run', parent: 'old', source: 'assistant', content: { text: 'new answer' }, provider: null }];
  next.historyPage = { head: 'new', previous: null, afterHeadId: 'old' };
  const reset = { ...structuredClone(first), history: [], historyPage: { head: null, previous: null } };
  const snapshot = vi.fn<ThreadsAPI['snapshot']>().mockResolvedValueOnce(first).mockResolvedValueOnce(next).mockResolvedValueOnce(reset);
  const h = await startProjection(snapshot);
  try {
    const old = h.publish.mock.lastCall![0] as ThreadSnapshot;
    h.listener({ cursor: 7, thread_id: identity.threadId, branch_id: identity.branchId, subject: 'run', revision: 2, kind: 'history.appended', data: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot.mock.calls[1]?.[2]).toEqual({ afterHeadId: 'old' });
    const value = h.publish.mock.lastCall![0] as ThreadSnapshot;
    expect(value.history.map(item => item.id)).toEqual(['old', 'new']);
    expect(value.history[0]).toBe(old.history[0]); expect(value.thread).toBe(old.thread); expect(value.context).toBe(old.context);
    h.listener({ stream: 'resync', cursor: 0, reason: 'kernel-restarted', kernelEpoch: 'next' });
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot.mock.calls[2]?.[2]).toBeUndefined();
    expect(h.publish.mock.lastCall![0].history).toEqual([]);
  } finally { h.projection.close(); }
});

it('recovers a commit between the initial snapshot and establishing the event subscription', async () => {
  const view = snapshotView();
  let ready!: () => void;
  const api = { snapshot: vi.fn(async () => structuredClone(view)),
    observe: async (_cursor: number | null, _listener: Parameters<ThreadsAPI['observe']>[1], { signal, onReady }: Parameters<ThreadsAPI['observe']>[2]) => {
      ready = onReady!;
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    } } as unknown as ThreadsAPI;
  const publish = vi.fn(), projection = new ThreadProjection(api, identity, publish, vi.fn(), undefined, undefined, undefined, { contextInspection: false });
  try {
    projection.start(); await Promise.resolve(); await Promise.resolve();
    expect(publish.mock.lastCall![0].history).toEqual([]);
    view.history = [{ id: 'raced', thread_id: identity.threadId, run_id: 'run', parent: null, source: 'assistant', content: { text: 'committed before SSE ready' }, provider: null }];
    view.historyPage = { head: 'raced', previous: null }; view.eventCursor = 7;
    ready(); await Promise.resolve(); await Promise.resolve();
    expect(api.snapshot).toHaveBeenCalledTimes(2);
    expect(publish.mock.lastCall![0].history[0].id).toBe('raced');
  } finally { projection.close(); }
});

it('catches a child finishing while its parent snapshot first discovers the child identity', async () => {
  const pending = deferred();
  const discovered = snapshotView();
  discovered.children = [{ child_thread_id: 'new-child', state: 'running' } as NonNullable<ThreadSnapshot['children']>[number]];
  const latest = structuredClone(discovered); latest.eventCursor = 7; latest.children![0]!.state = 'succeeded';
  const snapshot = vi.fn<ThreadsAPI['snapshot']>().mockImplementationOnce(async () => { await pending.promise; return discovered; }).mockResolvedValue(latest);
  const h = await startProjection(snapshot);
  try {
    h.listener({ cursor: 7, thread_id: 'new-child', branch_id: 'child-branch', subject: 'child-run', revision: 2, kind: 'run.completed', data: {} });
    expect(snapshot).toHaveBeenCalledTimes(1);
    pending.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(h.publish.mock.lastCall![0].children[0].state).toBe('succeeded');
  } finally { h.projection.close(); }
});


it.each(['model.settled', 'inference.settled', 'usage.updated'])('refreshes same-head assistant metadata on %s without discarding loaded older history', async kind => {
  const first = snapshotView(false);
  const older = { id: 'older', thread_id: identity.threadId, run_id: 'run', parent: null,
    source: 'user' as const, content: { text: 'older original' }, provider: null };
  first.history = [
    { ...older, id: 'prompt', parent: older.id, content: { text: 'current prompt' } },
    { ...older, id: 'answer', source: 'assistant', parent: 'prompt', content: { text: 'answer' },
      modelRequest: { requestId: 'request', providerFamily: 'fixture', modelId: 'fixture',
        usage: { measurement: 'missing', inputTokens: null, outputTokens: null } } },
  ];
  first.historyPage = { head: 'answer', previous: 'prompt' };
  const refined = structuredClone(first);
  refined.history[1]!.modelRequest!.usage = { measurement: 'actual', inputTokens: 100, outputTokens: 25 };
  const next = structuredClone(refined);
  next.history = [{ ...older, id: 'followup', parent: 'answer', content: { text: 'next user input' } }];
  next.historyPage = { head: 'followup', previous: 'prompt', afterHeadId: 'answer' };
  const snapshot = vi.fn<ThreadsAPI['snapshot']>().mockResolvedValueOnce(first).mockResolvedValueOnce(refined).mockResolvedValueOnce(next);
  const h = await startProjection(snapshot);
  const history = new ThreadHistoryWindow({
    historyPage: async () => ({ head: 'answer', previous: null, items: [older] }),
    historyUsage: async () => [], historyRuns: async (_identity, { headId }) => ({ head: headId, runs: [] }),
    historyRunPreview: async () => '',
  }, identity, { usage: false });
  const close = history.subscribe(() => {});
  try {
    const original = h.publish.mock.lastCall![0] as ThreadSnapshot;
    history.accept(original);
    await history.loadEarlier();
    expect(history.getSnapshot().items.map(item => item.id)).toEqual(['older', 'prompt', 'answer']);
    const oldBody = history.getSnapshot().items[0];
    h.listener({ cursor: 7, thread_id: identity.threadId, branch_id: identity.branchId,
      subject: 'request', revision: 3, kind, data: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot.mock.calls[1]?.[2]).toBeUndefined();
    const latest = h.publish.mock.lastCall![0] as ThreadSnapshot;
    expect(latest.history[1]!.modelRequest?.usage.inputTokens).toBe(100);
    expect(latest.history[0]).toBe(original.history[0]);
    history.accept(latest);
    expect(history.getSnapshot().items.map(item => item.id)).toEqual(['older', 'prompt', 'answer']);
    expect(history.getSnapshot().items[0]).toBe(oldBody);
    expect(history.getSnapshot().items[2]!.modelRequest?.usage.measurement).toBe('actual');
    h.listener({ cursor: 8, thread_id: identity.threadId, branch_id: identity.branchId,
      subject: 'run', revision: 4, kind: 'history.appended', data: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot.mock.calls[2]?.[2]).toEqual({ afterHeadId: 'answer' });
    history.accept(h.publish.mock.lastCall![0]);
    expect(history.getSnapshot().items.map(item => item.id)).toEqual(['older', 'prompt', 'answer', 'followup']);
    expect(h.report).not.toHaveBeenCalled();
  } finally { close(); h.projection.close(); }
});


it.each(['failed', 'cancelled'] as const)('refreshes a manual context helper becoming %s without a parent Run wake', async state => {
  const view = snapshotView(false);
  const helper = { ...snapshotView().activeRun!, id: 'manual-context-run',
    thread_id: 'context-job-thread:manual', branch_id: 'context-job-branch:manual' };
  const job: ThreadSnapshot['context']['jobs'][number] = {
    run: helper,
    job: {
      compaction: { producer: { kind: 'builtin', name: 'fold', version: '1' }, kind: 'text', sourceCutHash: 'source', planHash: 'plan' },
      request: { compaction: null, summary_recipe: { strategy: { kind: 'builtin', name: 'fold', version: '1' },
        mode: 'manual', configurationIdentity: null, additionalInstructions: null },
        key: 'manual', branch_id: identity.branchId, through_id: 'parent-head', expected_revision: 0,
        effective_system_prompt: '', instruction_sources: [], memory_checkpoint: null },
      receipt: { thread_id: helper.thread_id, branch_id: helper.branch_id, run_id: helper.id, input_id: 'manual-input', cursor: 7 },
    },
  };
  const snapshot = vi.fn<ThreadsAPI['snapshot']>(async () => structuredClone(view));
  const h = await startProjection(snapshot);
  try {
    expect(snapshot).toHaveBeenCalledTimes(1);
    view.context.jobs = [job]; view.eventCursor = 7;
    h.listener({ cursor: 7, thread_id: identity.threadId, branch_id: identity.branchId,
      subject: identity.branchId, revision: 1, kind: 'context.job_created', data: { run_id: helper.id } });
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot).toHaveBeenCalledTimes(2);
    h.listener({ cursor: 8, thread_id: 'context-job-thread:unrelated', branch_id: 'context-job-branch:unrelated',
      subject: 'other-context-run', revision: 2, kind: `run.${state}`, data: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot).toHaveBeenCalledTimes(2);
    job.run = { ...helper, state, revision: 2 }; view.eventCursor = 9;
    h.listener({ cursor: 9, thread_id: helper.thread_id, branch_id: helper.branch_id,
      subject: helper.id, revision: 2, kind: `run.${state}`, data: job.run });
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot).toHaveBeenCalledTimes(3);
    expect(h.publish.mock.lastCall![0].context.jobs[0].run.state).toBe(state);
    expect(h.report).not.toHaveBeenCalled();
    // Removing a job also removes its helper interest; retained old helper events
    // must not keep refreshing the parent after that relationship disappears.
    view.context.jobs = []; view.eventCursor = 10;
    h.listener({ cursor: 10, thread_id: identity.threadId, branch_id: identity.branchId,
      subject: identity.branchId, revision: 2, kind: 'context.published', data: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot).toHaveBeenCalledTimes(4);
    h.listener({ cursor: 11, thread_id: helper.thread_id, branch_id: helper.branch_id,
      subject: helper.id, revision: 3, kind: 'run.changed', data: job.run });
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot).toHaveBeenCalledTimes(4);
  } finally { h.projection.close(); }
});
