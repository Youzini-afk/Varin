import { expect, it, vi } from 'vitest';
import { createThreadNotificationRuntime } from './thread-runtime.js';
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
it('projects only new native durable facts with original Thread and branch identity', async () => {
  let onEvent: (event: { stream: string }) => void = () => {};
  const events: Array<{ cursor: number; kind: string; data?: unknown; subject?: string }> = [];
  const send = vi.fn(async (_value: unknown) => {});
  const runtime = { status: async () => ({ eventCursor: 10 }), events: async (cursor: number) => events.filter(event => event.cursor > cursor),
    thread: async (id: string) => ({ title: 'Native original', deleted_at_ms: null, archived: false, parent_thread_id: id === 'child-thread' ? 'thread' : null }),
    childExecutionForRun: async (id: string) => id === 'child' ? {} : null,
    operation: async (id: string) => ({ run_id: id === 'child-permission' ? 'child-continuation' : 'root', phase: 'awaiting' }),
    run: async (id: string) => ({ id, thread_id: id === 'root' ? 'thread' : 'child-thread', branch_id: id === 'root' ? 'branch' : 'child-branch' }),
    onEvent: (fn: typeof onEvent) => { onEvent = fn; return () => {}; }, onReady: () => () => {}, onExit: () => () => {} };
  const owner = createThreadNotificationRuntime({ runtime: runtime as never, send, onError: error => { throw error; } });
  await flush(); expect(send).not.toHaveBeenCalled();
  events.push({ cursor: 11, kind: 'run.changed', data: { id: 'child', state: 'completed', thread_id: 'child-thread', branch_id: 'child-branch' } },
    { cursor: 12, kind: 'run.changed', data: { id: 'root', state: 'completed', thread_id: 'thread', branch_id: 'branch' } },
    { cursor: 13, kind: 'question.opened', subject: 'original-question' },
    { cursor: 14, kind: 'run.changed', data: { id: 'child-continuation', state: 'completed', thread_id: 'child-thread', branch_id: 'child-branch' } },
    { cursor: 15, kind: 'run.changed', data: { id: 'child-retry', state: 'failed', thread_id: 'child-thread', branch_id: 'child-branch' } },
    { cursor: 16, kind: 'permission.opened', subject: 'child-permission' });
  onEvent({ stream: 'durable' }); await flush();
  expect(send.mock.calls.map(([value]) => value)).toMatchObject([
    { threadId: 'thread', branchId: 'branch', runId: 'root', kind: 'completion', title: 'Native original' },
    { threadId: 'thread', branchId: 'branch', runId: 'root', kind: 'attention' },
    { threadId: 'child-thread', branchId: 'child-branch', runId: 'child-continuation', kind: 'attention' }]);
  onEvent({ stream: 'durable' }); await flush(); expect(send).toHaveBeenCalledTimes(3);
  await owner.dispose();
});
it('drains the original presentation send on shutdown rather than treating abort as delivery completion', async () => {
  let onEvent: (event: { stream: string }) => void = () => {}, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const events: unknown[] = [];
  const runtime = { status: async () => ({ eventCursor: 0 }), events: async (cursor: number) => cursor === 0 ? events : [],
    thread: async () => ({ title: 'Original', deleted_at_ms: null, archived: false }), childExecutionForRun: async () => null,
    onEvent: (fn: typeof onEvent) => { onEvent = fn; return () => {}; }, onReady: () => () => {}, onExit: () => () => {} };
  const send = vi.fn(() => gate); const owner = createThreadNotificationRuntime({ runtime: runtime as never, send, onError: () => {} }); await flush();
  events.push({ cursor: 1, kind: 'run.changed', data: { id: 'root', state: 'completed', thread_id: 'thread', branch_id: 'branch' } });
  onEvent({ stream: 'durable' }); await flush(); expect(send).toHaveBeenCalledOnce();
  let stopped = false; const stopping = owner.dispose().then(() => { stopped = true; }); await flush(); expect(stopped).toBe(false);
  release(); await stopping; expect(stopped).toBe(true);
});
