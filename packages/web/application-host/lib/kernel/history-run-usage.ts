import type { ThreadHistoryPage, ThreadRunUsage } from '@varin/application-client';
import type { HistoryItem, ModelPresentation } from '@varin/protocol';
import type { AgentRuntimeClient } from './agent-runtime-client.js';

type Reader = Pick<AgentRuntimeClient, 'run' | 'historyPage' | 'historyItem' | 'modelPresentations'>;

export function historyModelRequestId(item: HistoryItem): string | undefined {
  if (item.source !== 'assistant') return undefined;
  const id = (item.content as { id?: unknown } | null)?.id;
  if (typeof id !== 'string') return undefined;
  const prefix = /^model-item:(\d+):/.exec(id);
  return prefix ? Buffer.from(id.slice(prefix[0].length)).subarray(0, Number(prefix[1])).toString('utf8') : undefined;
}

/** Read original history; never infer a Run boundary from a paginated UI row. */
export class HistoryRunUsageReader {
  constructor(private readonly runtime: Reader) {}
  // Only immutable request identities are cached. Receipts are read again so a
  // late original usage publication can refine an unknown count.
  private earlierRequests = new Map<string, string[]>();

  async read(branchId: string, page: ThreadHistoryPage, presentations: readonly ModelPresentation[], signal?: AbortSignal): Promise<ThreadRunUsage[]> {
    const runIds = [...new Set(page.items.map(item => item.run_id))];
    const runs = await Promise.all(runIds.map(id => this.runtime.run(id, signal)));
    const ended = new Set(runs.filter(run => ['completed', 'failed', 'cancelled'].includes(run.state)).map(run => run.id));
    const requests = new Map([...ended].map(id => [id, new Set<string>()]));
    for (const item of page.items) {
      const id = historyModelRequestId(item);
      if (id) requests.get(item.run_id)?.add(id);
    }
    const first = page.items[0];
    if (first && page.head && page.previous && ended.has(first.run_id)) {
      const key = JSON.stringify([branchId, first.id]);
      let earlier = this.earlierRequests.get(key);
      if (!earlier) {
        earlier = await this.readEarlier(branchId, page.head, page.previous, first.run_id, signal);
        this.earlierRequests.set(key, earlier);
      }
      for (const id of earlier) requests.get(first.run_id)!.add(id);
    }
    const metadata = new Map(presentations.map(view => [view.requestId, view]));
    const missing = [...new Set([...requests.values()].flatMap(ids => [...ids]))].filter(id => !metadata.has(id));
    if (missing.length) for (const view of await this.runtime.modelPresentations(missing, signal)) metadata.set(view.requestId, view);
    return [...requests].map(([runId, ids]) => ({ runId, throughId: page.items.slice().reverse().find(item => item.run_id === runId)!.id, requests: [...ids].map(requestId => {
      const view = metadata.get(requestId);
      if (!view) throw new Error('Original history usage is unavailable');
      return { requestId, usage: view.usage };
    }) }));
  }

  private async readEarlier(branchId: string, headId: string, beforeId: string, runId: string, signal?: AbortSignal): Promise<string[]> {
    const requests = new Set<string>();
    let before: string | null = beforeId;
    while (before) {
      const page = await this.runtime.historyPage({ branchId, headId, beforeId: before, limit: 256 }, signal);
      const references = [];
      let reachedBoundary = false;
      for (const reference of page.items.slice().reverse()) {
        // Catalog only lets the active Run append to a branch, so its history is contiguous.
        if (reference.run_id !== runId) { reachedBoundary = true; break; }
        if (reference.source === 'assistant') references.push(reference);
      }
      const items = await Promise.all(references.map(reference => this.runtime.historyItem(reference, signal)));
      for (const item of items) {
        const id = historyModelRequestId(item);
        if (id) requests.add(id);
      }
      if (reachedBoundary) break;
      before = page.previous;
    }
    return [...requests];
  }
}
