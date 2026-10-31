import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { ThreadSummary } from '../kernel/protocol.generated.js';
import type { ModelTextService } from './service.js';
import { buildThreadTitleContext, THREAD_TITLE_SYSTEM } from './thread-title-context.js';

type Runtime = Pick<AgentRuntimeClient, 'thread' | 'threads' | 'prepareThreadTitle' | 'finishThreadTitle' | 'historyPage' | 'historyItem' | 'context' | 'run' | 'onEvent' | 'onReady' | 'onExit' | 'status' | 'events'>;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
export const DEFAULT_TITLE_UPDATE_INTERVAL = 5;

/** Catalog owns title identity and the frozen cut. These maps only coalesce observers. */
export function createThreadTitleService(options: {
  runtime: Runtime;
  modelText: Pick<ModelTextService, 'generate' | 'original' | 'resumeUnsent'>;
  readSettings(): Promise<unknown>;
  botSession?(thread: ThreadSummary, signal: AbortSignal): Promise<boolean>;
  onError(error: unknown): void;
}) {
  const lifetime = new AbortController();
  const pending = new Map<string, { controller: AbortController; promise: Promise<void>; again: boolean; initial: boolean }>();
  const inflight = new Set<Promise<void>>();
  let closed = false, epoch = 0;
  let recovering: Promise<void> = Promise.resolve();
  const eligible = async (thread: ThreadSummary, signal: AbortSignal) => !thread.parent_thread_id && thread.deleted_at_ms === null
    && thread.title_mode !== 'manual' && (!thread.bot_id || Boolean(options.botSession && await options.botSession(thread, signal)));
  async function interval() {
    const value = record(await options.readSettings()).titleUpdateInterval;
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_TITLE_UPDATE_INTERVAL;
  }
  function scheduleBranch(threadId: string, branchId: string, initial = false): Promise<void> {
    const existing = pending.get(branchId);
    if (existing) { existing.again = true; existing.initial ||= initial; return existing.promise; }
    if (closed) return Promise.resolve();
    const controller = new AbortController();
    const work = { controller, promise: Promise.resolve(), again: false, initial };
    work.promise = (async () => {
      do {
        work.again = false;
        const thread = await options.runtime.thread(threadId, controller.signal);
        if (!await eligible(thread, controller.signal)) return;
        const job = await options.runtime.prepareThreadTitle({ threadId, branchId, interval: await interval(), initial: work.initial }, controller.signal);
        work.initial = false;
        if (!job) continue;
        let settled = false;
        try {
          const original = await options.modelText.original(job.key, controller.signal);
          const result = original ? await options.modelText.resumeUnsent(job.key, controller.signal)
            : await options.modelText.generate({ key: job.key, purpose: 'title', system: THREAD_TITLE_SYSTEM,
              prompt: await buildThreadTitleContext(options.runtime, job, controller.signal), signal: controller.signal });
          const title = result?.text.split(/\r?\n/u).map(line => line.trim()).find(Boolean) ?? null;
          settled = await options.runtime.finishThreadTitle({ job, title }, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) throw error;
          await options.runtime.finishThreadTitle({ job, title: null }, controller.signal);
          options.onError(error);
        }
        if (settled) work.again = true;
      } while (!closed && !controller.signal.aborted && work.again);
    })().catch(error => { if (!controller.signal.aborted && !closed) options.onError(error); })
      .finally(() => {
        inflight.delete(work.promise);
        if (pending.get(branchId) === work) pending.delete(branchId);
        if (work.again && !closed && !controller.signal.aborted) void scheduleBranch(threadId, branchId, work.initial);
      });
    pending.set(branchId, work);
    inflight.add(work.promise);
    return work.promise;
  }
  function recover() {
    const generation = epoch;
    recovering = recovering.then(async () => {
      const checks: Promise<void>[] = [];
      for (const thread of await options.runtime.threads(lifetime.signal)) {
        if (closed || generation !== epoch) return;
        if (!await eligible(thread, lifetime.signal)) continue;
        for (const branch of thread.branches) if (branch.head) checks.push(scheduleBranch(thread.thread_id, branch.branch_id, true));
      }
      await Promise.allSettled(checks);
    }).catch(error => { if (!closed) options.onError(error); });
    return recovering;
  }

  let cursor: number | undefined, notified = 0, firstNotification: number | undefined;
  let pumping = false, initializing: Promise<void> | undefined;
  async function pump() {
    if (closed || pumping || cursor === undefined) return;
    pumping = true;
    const generation = epoch;
    try {
      while (!closed && generation === epoch && cursor !== undefined && cursor < notified) {
        const events = await options.runtime.events(cursor, 256, lifetime.signal);
        if (generation !== epoch || !events.length) break;
        for (const event of events) {
          cursor = event.cursor;
          const data = record(event.data);
          if (event.kind === 'run.changed' && data.state === 'completed' && typeof data.thread_id === 'string' && typeof data.branch_id === 'string' && data.branch_id) {
            void scheduleBranch(data.thread_id, data.branch_id);
          } else if (event.kind === 'thread.updated' && (typeof data.title === 'string' || data.titleMode === 'automatic' || data.titleMode === 'manual')) {
            const thread = await options.runtime.thread(event.subject, lifetime.signal);
            for (const branch of thread.branches) {
              if (thread.title_mode === 'manual') {
                pending.get(branch.branch_id)?.controller.abort(); pending.delete(branch.branch_id);
              } else if (data.titleMode === 'automatic' && branch.head) void scheduleBranch(thread.thread_id, branch.branch_id, true);
            }
          }
        }
      }
    } catch (error) { if (!closed) options.onError(error); }
    finally { pumping = false; }
  }
  function initialize() {
    if (closed || initializing || cursor !== undefined) return;
    const generation = epoch;
    initializing = options.runtime.status(lifetime.signal).then(status => {
      if (generation !== epoch || closed) return;
      cursor = Math.min(status.eventCursor, firstNotification === undefined ? status.eventCursor : firstNotification - 1);
      notified = Math.max(notified, status.eventCursor); void pump(); void recover();
    }).catch(error => { if (!closed) options.onError(error); }).finally(() => { initializing = undefined; });
  }
  const remove = [options.runtime.onEvent(event => {
    if (event.stream !== 'durable') return;
    firstNotification ??= event.cursor; notified = Math.max(notified, event.cursor);
    if (cursor === undefined) initialize(); else void pump();
  }), options.runtime.onReady(initialize), options.runtime.onExit(() => {
    epoch++; cursor = undefined; notified = 0; firstNotification = undefined;
    for (const work of pending.values()) work.controller.abort();
    pending.clear();
  })];
  initialize();
  return {
    recover,
    schedule(thread: ThreadSummary, branchId = thread.main_branch_id): void {
      if (!thread.parent_thread_id && branchId) void scheduleBranch(thread.thread_id, branchId, true);
    },
    settingsChanged: recover,
    async close(): Promise<void> {
      closed = true; lifetime.abort(); remove.forEach(unsubscribe => unsubscribe());
      for (const work of pending.values()) work.controller.abort();
      await Promise.allSettled([...inflight]);
      await Promise.allSettled([recovering, initializing]);
    },
  };
}
export type ThreadTitleService = ReturnType<typeof createThreadTitleService>;
