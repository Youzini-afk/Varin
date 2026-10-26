import type { ThreadContextInspection } from '@varin/application-client';
import type { HistoryReference } from '@varin/protocol';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import { historyModelRequestId } from './history-run-usage.js';

interface Summary {
  counts: ThreadContextInspection['counts'];
  latest: HistoryReference | null;
  context: HistoryReference | null;
}
const empty = (): Summary => ({ counts: { total: 0, user: 0, assistant: 0, tool: 0 }, latest: null, context: null });

/** Cache immutable ancestry metadata; read the latest receipt again so late usage can arrive. */
export class ThreadContextReader {
  private branches = new Map<string, Map<string, Summary>>();
  private composition = new Map<string, { requestId: string; value: import('@varin/protocol').ModelContextComposition }>();
  constructor(private runtime: Pick<AgentRuntimeClient, 'historyPage' | 'historyItem' | 'modelPresentations'>) {}

  async read(branchId: string, headId: string | null, signal?: AbortSignal): Promise<ThreadContextInspection> {
    if (!headId) return { head: null, counts: empty().counts, latestRequest: null, contextRequest: null };
    let known = this.branches.get(branchId);
    if (!known) { known = new Map(); this.branches.set(branchId, known); }
    // Validate even a cached cut through the original Catalog owner.
    let page = await this.runtime.historyPage({ branchId, headId, limit: known.has(headId) ? 1 : 256 }, signal);
    const pending: HistoryReference[] = [];
    let summary = empty();
    let cursor: string | null = headId;
    while (cursor) {
      signal?.throwIfAborted();
      const cached = known.get(cursor);
      if (cached) { summary = cached; break; }
      for (const reference of page.items.slice().reverse()) {
        if (reference.id !== cursor) throw new Error('Context history does not match its anchored cut');
        const cached = known.get(reference.id);
        if (cached) { summary = cached; cursor = null; break; }
        pending.push(reference); cursor = reference.parent;
      }
      if (cursor) {
        if (!page.previous || !page.items.length) throw new Error('Context history is incomplete');
        page = await this.runtime.historyPage({ branchId, headId, beforeId: page.previous, limit: 256 }, signal);
      }
    }
    for (const reference of pending.reverse()) {
      const counts = { ...summary.counts, total: summary.counts.total + 1 };
      if (reference.source === 'user' || reference.source === 'assistant' || reference.source === 'tool') counts[reference.source] += 1;
      summary = { counts, latest: reference.source === 'assistant' ? reference : summary.latest,
        context: reference.source === 'compaction' ? null : reference.source === 'assistant' ? reference : summary.context };
      known.set(reference.id, summary);
    }
    const item = summary.latest ? await this.runtime.historyItem(summary.latest, signal) : null;
    const requestId = item ? historyModelRequestId(item) : undefined;
    const cachedComposition = this.composition.get(branchId);
    const knownComposition = cachedComposition && cachedComposition.requestId === requestId ? cachedComposition.value : undefined;
    const latestRequest = requestId ? (await this.runtime.modelPresentations([requestId], signal, !knownComposition))[0] ?? null : null;
    if (latestRequest && requestId) {
      if (knownComposition) latestRequest.context = knownComposition;
      else if (latestRequest.context) this.composition.set(branchId, { requestId, value: latestRequest.context });
    }
    return { head: headId, counts: summary.counts, latestRequest,
      contextRequest: summary.context?.id === summary.latest?.id ? latestRequest : null };
  }
}
