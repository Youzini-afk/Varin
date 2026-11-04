import type { ThreadHistoryRuns, ThreadTreePreview } from '@varin/application-client';
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

  async treePreview(branchId: string, range: { firstItemId: string; lastItemId: string; query?: string }, signal?: AbortSignal): Promise<ThreadTreePreview> {
    const query = range.query?.trim().toLocaleLowerCase();
    const result: ThreadTreePreview = { user: '', assistant: '', activity: '', ...(query ? { matched: false } : {}) };
    const excerpt = (value: string, length: number) => {
      const match = query ? value.toLocaleLowerCase().indexOf(query) : -1;
      if (match >= 0) result.matched = true;
      const start = Math.max(0, match - 50);
      return `${start ? '…' : ''}${Array.from(value.slice(start, start + length * 2)).slice(0, length).join('')}`;
    };
    let beforeId: string | undefined;
    let complete = false;
    while (!complete) {
      const page = await this.runtime.historyPage({ branchId, headId: range.lastItemId, ...(beforeId ? { beforeId } : {}), limit: 64 }, signal);
      if (!page.items.length) throw new Error('Conversation tree range is unavailable');
      for (const reference of page.items.slice().reverse()) {
        signal?.throwIfAborted();
        if (reference.source === 'user' || reference.source === 'agent' && !result.user) {
          const item = await this.runtime.historyItem(reference, signal);
          result.user = excerpt(previewText(item), 240);
        } else if (reference.source === 'assistant' && (!result.assistant || query)) {
          const item = await this.runtime.historyItem(reference, signal);
          const text = previewText(item);
          const matched = query && text.toLocaleLowerCase().includes(query);
          if (!result.assistant || matched) result.assistant = excerpt(text, 320);
          result.activity ||= excerpt(previewText(item, true), 160);
        }
        if (reference.id === range.firstItemId) { complete = true; break; }
      }
      if (!complete && !page.previous) throw new Error('Conversation tree range is unavailable');
      beforeId = page.previous ?? undefined;
    }
    return result;
  }
}

function previewText(item: HistoryItem, activity = false): string {
  if (typeof item.content === 'string') return item.content;
  const envelope = item.content as { text?: string; userText?: string; content?: { kind?: string; text?: string; call?: { name?: string } } } | null;
  if (item.source === 'user') return envelope?.userText ?? envelope?.text ?? '';
  const content = envelope?.content;
  return content?.kind === 'text' ? content.text ?? '' : activity && content?.kind === 'tool_call' ? content.call?.name ?? '' : '';
}
