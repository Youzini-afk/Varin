import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { HistoryReference } from '@varin/protocol';
import { UiContentError } from './store.js';

type Index = { head: string | undefined; items: Map<string, HistoryReference>; before?: string | undefined; complete: boolean; loaded: boolean;
  reading?: Promise<void>; previous?: Index | undefined };
/** Metadata is cached only after native ancestry validation, against an actual branch head.
 * Concurrent fragments share page reads. Appending history reuses the proven old suffix;
 * rewind/replacement must reach that suffix again before any old entry is visible. */
export function createFragmentHistory(runtime: Pick<AgentRuntimeClient, 'historyPage' | 'historyItem'>) {
  const branches = new Map<string, Index>();
  const bodies = new WeakMap<HistoryReference, Promise<Awaited<ReturnType<AgentRuntimeClient['historyItem']>>>>();
  return {
    async find(threadId: string, branchId: string, head: string | null | undefined, messageId: string, signal?: AbortSignal) {
      const key = JSON.stringify([threadId, branchId]);
      const previous = branches.get(key);
      let index = head !== undefined && previous?.head === head ? previous : undefined;
      if (!index) {
        index = { head: head ?? undefined, items: new Map(), complete: head === null, loaded: head === null,
          previous: previous ? { ...previous, previous: undefined } : undefined };
        if (head !== undefined) branches.set(key, index);
      }
      const current = index;
      while (!current.items.has(messageId) && !current.complete) {
        signal?.throwIfAborted();
        current.reading ??= (async () => {
          // A caller leaving the page must not cancel another fragment's shared read.
          const page = await runtime.historyPage({ branchId, limit: 100, ...(current.head ? { headId: current.head } : {}), ...(current.before ? { beforeId: current.before } : {}) });
          if (current.head && (page.head !== current.head || page.boundary_reset)) throw new UiContentError('Conversation history changed; reopen this fragment', 409);
          current.head = page.head ?? undefined;
          for (const item of page.items) current.items.set(item.id, item);
          const reusable = current.previous;
          if (reusable?.head && page.items.some(item => item.id === reusable.head) && reusable.loaded && !reusable.reading) {
            for (const [id, item] of reusable.items) if (!current.items.has(id)) current.items.set(id, item);
            current.before = reusable.before; current.complete = reusable.complete;
          } else {
            if (page.previous === current.before && current.before) throw new UiContentError('History reader did not advance', 503);
            current.before = page.previous ?? undefined; current.complete = !page.previous;
          }
          current.loaded = true;
          if (current.complete || reusable?.head && current.items.has(reusable.head)) delete current.previous;
        })().finally(() => { delete current.reading; });
        try { await current.reading; } catch (error) { if (branches.get(key) === current) branches.delete(key); throw error; }
      }
      signal?.throwIfAborted();
      return current.items.get(messageId);
    },
    async body(reference: HistoryReference, signal?: AbortSignal) {
      signal?.throwIfAborted();
      let pending = bodies.get(reference);
      if (!pending) { pending = runtime.historyItem(reference).catch(error => { bodies.delete(reference); throw error; }); bodies.set(reference, pending); }
      const item = await pending; signal?.throwIfAborted(); return item;
    },
    forget(threadId: string) { for (const key of branches.keys()) if ((JSON.parse(key) as string[])[0] === threadId) branches.delete(key); },
  };
}
