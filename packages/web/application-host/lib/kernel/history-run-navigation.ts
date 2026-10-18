import type { ThreadHistoryRuns } from '@varin/application-client';
import type { HistoryItem, HistoryReference } from '@varin/protocol';
import type { AgentRuntimeClient } from './agent-runtime-client.js';

/** Metadata-only ancestry index. Native reads validate every selected cut;
 * cached immutable references only avoid rescanning an already visited prefix. */
export class HistoryRunNavigationReader {
  private branches = new Map<string, Map<string, HistoryReference>>();
  constructor(private runtime: Pick<AgentRuntimeClient, 'historyPage' | 'historyItem'>) {}

  private async references(branchId: string, headId: string, signal?: AbortSignal) {
    let known = this.branches.get(branchId);
    if (!known) { known = new Map(); this.branches.set(branchId, known); }
    // Even a cached head must still belong to this branch's current ancestry.
    const page = await this.runtime.historyPage({ branchId, headId, limit: known.has(headId) ? 1 : 256 }, signal);
    for (const reference of page.items) known.set(reference.id, reference);
    const reverse: HistoryReference[] = [];
    let cursor: string | null = headId;
    let beforeId: string | undefined;
    while (cursor) {
      signal?.throwIfAborted();
      const reference = known.get(cursor);
      if (reference) { reverse.push(reference); beforeId = reference.id; cursor = reference.parent; continue; }
      const earlier = await this.runtime.historyPage({ branchId, headId, ...(beforeId ? { beforeId } : {}), limit: 256 }, signal);
      if (!earlier.items.length || earlier.items.at(-1)?.id !== cursor) throw new Error('History index does not match its anchored cut');
      for (const item of earlier.items) known.set(item.id, item);
    }
    return reverse.reverse();
  }

  async read(branchId: string, headId: string | null, signal?: AbortSignal): Promise<ThreadHistoryRuns> {
    if (!headId) return { head: null, runs: [] };
    const items = await this.references(branchId, headId, signal);
    const runs: ThreadHistoryRuns['runs'] = [];
    for (const item of items) {
      const last = runs.at(-1);
      if (last?.runId === item.run_id) last.lastItemId = item.id;
      else runs.push({ runId: item.run_id, firstItemId: item.id, lastItemId: item.id });
    }
    return { head: headId, runs };
  }

  async preview(branchId: string, headId: string, runId: string, signal?: AbortSignal): Promise<string> {
    const references = (await this.references(branchId, headId, signal)).filter(item => item.run_id === runId);
    if (!references.length) throw new Error('Run is not on the selected history cut');
    const prompt = references.find(item => item.source === 'user' || item.source === 'agent');
    const assistant = references.slice().reverse().find(item => item.source === 'assistant');
    const [question, response] = await Promise.all([
      prompt ? this.runtime.historyItem(prompt, signal) : undefined,
      assistant ? this.runtime.historyItem(assistant, signal) : undefined,
    ]);
    return response && previewText(response) || question && previewText(question) || response && previewText(response, true) || '';
  }
}

function previewText(item: HistoryItem, activity = false): string {
  if (typeof item.content === 'string') return item.content;
  const envelope = item.content as { text?: string; content?: { kind?: string; text?: string; call?: { name?: string } } } | null;
  if (item.source === 'user') return envelope?.text ?? '';
  const content = envelope?.content;
  return content?.kind === 'text' ? content.text ?? '' : activity && content?.kind === 'tool_call' ? content.call?.name ?? '' : '';
}
