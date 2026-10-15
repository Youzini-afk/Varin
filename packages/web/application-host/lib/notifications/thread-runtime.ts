import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { Run, RuntimeEvent } from '@varin/protocol';

export interface ThreadNotification {
  threadId: string;
  branchId: string;
  runId: string;
  kind: 'completion' | 'error' | 'attention';
  title: string;
  body: string;
  tag: string;
}
/** Notifications project committed native facts. They never admit, resume or cancel work.
 * Catalog read cursors retain unread state; OS notifications are live presentation only. */
export function createThreadNotificationRuntime(options: {
  runtime: Pick<AgentRuntimeClient, 'status' | 'events' | 'thread' | 'run' | 'operation' | 'childExecutionForRun' | 'onEvent' | 'onReady' | 'onExit'>;
  send(notification: ThreadNotification): Promise<void>;
  onError(error: unknown): void;
}) {
  let stopped = false;
  let epoch = 0;
  let cursor: number | undefined;
  let dirty = false;
  let pumping: Promise<void> | undefined;
  const lifetime = new AbortController();
  const notification = async (event: RuntimeEvent): Promise<void> => {
    let run: Run;
    let kind: ThreadNotification['kind'];
    let body: string;
    if (event.kind === 'run.changed') {
      run = event.data as Run;
      if (!run || !['completed', 'failed'].includes(run.state)) return;
      if (await options.runtime.childExecutionForRun(run.id, lifetime.signal)) return;
      kind = run.state === 'completed' ? 'completion' : 'error';
      body = run.state === 'completed' ? 'Response finished.' : 'This conversation needs attention after a failed run.';
    } else if (event.kind === 'permission.opened' || event.kind === 'question.opened') {
      const operation = await options.runtime.operation(event.subject, lifetime.signal);
      if (operation.phase === 'terminal') return;
      run = await options.runtime.run(operation.run_id, lifetime.signal);
      kind = 'attention';
      body = event.kind === 'permission.opened' ? 'Your approval is needed.' : 'The agent has a question for you.';
    } else return;
    const thread = await options.runtime.thread(run.thread_id, lifetime.signal);
    if (thread.deleted_at_ms !== null || thread.archived) return;
    lifetime.signal.throwIfAborted();
    await options.send({ threadId: run.thread_id, branchId: run.branch_id, runId: run.id,
      kind, title: thread.title || 'Varin', body, tag: `thread:${run.id}:${event.kind}` });
  };
  const pump = (): void => {
    dirty = true;
    if (pumping || stopped || cursor === undefined) return;
    const generation = epoch;
    pumping = (async () => {
      while (dirty && !stopped && generation === epoch && cursor !== undefined) {
        dirty = false;
        for (;;) {
          const events = await options.runtime.events(cursor, 128, lifetime.signal);
          if (generation !== epoch || stopped) return;
          for (const event of events) {
            cursor = event.cursor;
            try { await notification(event); } catch (error) { if (!stopped) options.onError(error); }
          }
          if (events.length < 128) break;
        }
      }
    })().catch(error => { if (!stopped) options.onError(error); }).finally(() => {
      pumping = undefined;
      if (dirty && !stopped) pump();
    });
  };
  const initialize = async () => {
    const generation = ++epoch;
    cursor = undefined;
    try {
      const status = await options.runtime.status(lifetime.signal);
      if (stopped || generation !== epoch) return;
      cursor = status.eventCursor;
      pump();
    } catch (error) { if (!stopped) options.onError(error); }
  };
  const remove = [options.runtime.onEvent(event => { if (event.stream === 'durable') pump(); }),
    options.runtime.onReady(() => { void initialize(); }), options.runtime.onExit(() => { epoch++; cursor = undefined; })];
  void initialize();
  return { async dispose() { stopped = true; lifetime.abort(); for (const unsubscribe of remove) unsubscribe(); await pumping; } };
}
