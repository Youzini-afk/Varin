import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { ThreadSummary } from '../kernel/protocol.generated.js';
import type { ModelTextService } from './service.js';

/** Titles are auxiliary text requests; Catalog remains the metadata writer. */
export function createThreadTitleService(options: {
  runtime: Pick<AgentRuntimeClient, 'thread' | 'threads' | 'updateThread' | 'onReady'>;
  modelText: Pick<ModelTextService, 'generate' | 'original' | 'resumeUnsent'>;
  onError(error: unknown): void;
}) {
  const pending = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  const lifetime = new AbortController();
  const firstLine = (text: string) => text.split(/\r?\n/u).map(line => line.trim()).find(Boolean);
  let closed = false;
  let recovering: Promise<void> = Promise.resolve();
  const start = (threadId: string, work: (signal: AbortSignal) => Promise<void>) => {
    const existing = pending.get(threadId);
    if (existing) return existing.promise;
    if (closed) return Promise.resolve();
    const controller = new AbortController();
    const promise = work(controller.signal).catch(error => { if (!controller.signal.aborted) options.onError(error); })
      .finally(() => { pending.delete(threadId); });
    pending.set(threadId, { controller, promise });
    return promise;
  };
  const apply = async (threadId: string, fallback: string, text: string, signal: AbortSignal) => {
    const title = firstLine(text);
    if (!title || title === fallback) return;
    let current = await options.runtime.thread(threadId, signal);
    while (true) {
      signal.throwIfAborted();
      if (current.deleted_at_ms !== null || current.title !== fallback) return;
      try {
        await options.runtime.updateThread({ threadId, key: `thread-title:${threadId}:${current.revision}`,
          expectedRevision: current.revision, title }, signal);
        return;
      } catch (error) {
        signal.throwIfAborted();
        const refreshed = await options.runtime.thread(threadId, signal);
        // Pin/archive changes can race with the title CAS. Reuse the generated
        // result after that metadata change; a manual title always wins.
        if (refreshed.title !== fallback || refreshed.deleted_at_ms !== null) return;
        if (refreshed.revision === current.revision) throw error;
        current = refreshed;
      }
    }
  };
  const recover = () => {
    recovering = recovering.then(async () => {
      if (closed) return;
      for (const thread of await options.runtime.threads(lifetime.signal)) {
        if (closed) return;
        if (thread.parent_thread_id || thread.bot_id || thread.deleted_at_ms !== null) continue;
        // A metadata lookup must not reserve a new Thread and suppress the
        // first real schedule() arriving while startup discovery is running.
        const key = `thread-title:${thread.thread_id}`;
        let original;
        try { original = await options.modelText.original(key, lifetime.signal); }
        catch (error) { if (!closed) options.onError(error); continue; }
        if (original?.purpose !== 'title') continue;
        const fallback = firstLine(original.prompt);
        if (!fallback || thread.title !== fallback) continue;
        await start(thread.thread_id, async signal => {
          const current = await options.runtime.thread(thread.thread_id, signal);
          if (current.title !== fallback || current.deleted_at_ms !== null) return;
          const result = await options.modelText.resumeUnsent(key, signal);
          if (result) await apply(thread.thread_id, fallback, result.text, signal);
        });
      }
    }).catch(error => { if (!closed) options.onError(error); });
    return recovering;
  };
  const removeReady = options.runtime.onReady(() => { void recover(); });
  return {
    recover,
    schedule(thread: ThreadSummary, text: string): void {
      if (closed || pending.has(thread.thread_id) || thread.parent_thread_id || thread.bot_id
        || thread.title !== 'New thread' || thread.branches.some(branch => branch.latest_run)
        || !text.trim()) return;
      const fallback = firstLine(text)!;
      void start(thread.thread_id, async signal => {
        const result = await options.modelText.generate({ key: `thread-title:${thread.thread_id}`, purpose: 'title', prompt: text,
          system: "Write a concise conversation title for the user's request in the user's language. Return only the title.",
          signal });
        await apply(thread.thread_id, fallback, result.text, signal);
      });
    },
    async close(): Promise<void> {
      closed = true;
      removeReady(); lifetime.abort();
      for (const task of pending.values()) task.controller.abort();
      await Promise.allSettled([...pending.values()].map(task => task.promise));
      await recovering;
    },
  };
}
export type ThreadTitleService = ReturnType<typeof createThreadTitleService>;
