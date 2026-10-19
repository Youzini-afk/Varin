import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { ThreadSummary } from '../kernel/protocol.generated.js';
import type { ModelTextService } from './service.js';

/** Titles are auxiliary text requests; Catalog remains the metadata writer. */
export function createThreadTitleService(options: {
  runtime: Pick<AgentRuntimeClient, 'thread' | 'updateThread'>;
  modelText: Pick<ModelTextService, 'generate'>;
  onError(error: unknown): void;
}) {
  const pending = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  let closed = false;
  return {
    schedule(thread: ThreadSummary, text: string): void {
      if (closed || pending.has(thread.thread_id) || thread.parent_thread_id || thread.bot_id
        || thread.title !== 'New thread' || thread.branches.some(branch => branch.latest_run)
        || !text.trim()) return;
      const fallback = text.split(/\r?\n/u).map(line => line.trim()).find(Boolean)!;
      const controller = new AbortController();
      const promise = (async () => {
        const result = await options.modelText.generate({ key: `thread-title:${thread.thread_id}`, purpose: 'title', prompt: text,
          system: "Write a concise conversation title for the user's request in the user's language. Return only the title.",
          signal: controller.signal });
        controller.signal.throwIfAborted();
        const title = result.text.split(/\r?\n/u).map(line => line.trim()).find(Boolean);
        if (!title) return;
        const current = await options.runtime.thread(thread.thread_id, controller.signal);
        if (current.deleted_at_ms !== null || current.title !== fallback) return;
        await options.runtime.updateThread({ threadId: thread.thread_id, key: `thread-title:${thread.thread_id}:${current.revision}`,
          expectedRevision: current.revision, title }, controller.signal);
      })().catch(error => { if (!controller.signal.aborted) options.onError(error); })
        .finally(() => { pending.delete(thread.thread_id); });
      pending.set(thread.thread_id, { controller, promise });
    },
    async close(): Promise<void> {
      closed = true;
      for (const task of pending.values()) task.controller.abort();
      await Promise.allSettled([...pending.values()].map(task => task.promise));
    },
  };
}
export type ThreadTitleService = ReturnType<typeof createThreadTitleService>;
