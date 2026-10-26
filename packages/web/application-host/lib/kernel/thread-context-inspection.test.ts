import { expect, it, vi } from 'vitest';
import type { HistoryReference, ModelPresentation } from '@varin/protocol';
import { ThreadContextReader } from './thread-context-inspection.js';

it('keeps context outside the visible page, refreshes late usage and respects compaction and rewind', async () => {
  const references: HistoryReference[] = Array.from({ length: 450 }, (_, index) => ({ id: `${index}`, parent: index ? `${index - 1}` : null,
    thread_id: 'thread', run_id: 'run', source: index === 0 ? 'user' : index === 1 ? 'assistant' : 'tool', content_ref: `content:${index}` }));
  let currentHead = 449;
  const historyPage = vi.fn(async ({ headId, beforeId, limit }: { headId?: string; beforeId?: string; limit?: number }) => {
    const head = Number(headId);
    if (head > currentHead) throw new Error('history anchor is no longer on this branch');
    const end = beforeId ? Number(beforeId) : head + 1;
    const start = Math.max(0, end - limit!);
    return { head: headId!, previous: start ? `${start}` : null, items: references.slice(start, end) };
  });
  const historyItem = vi.fn(async (reference: HistoryReference) => ({ ...reference, provider: null, content: { id: 'model-item:7:requestanswer' } }));
  let contextTokens: number | null = null;
  const modelPresentations = vi.fn(async (_ids: string[], _signal?: AbortSignal, includeContext?: boolean): Promise<ModelPresentation[]> => [{ requestId: 'request', providerFamily: 'openai-completions', modelId: 'model', contextTokens,
    ...(includeContext ? { context: { checkpointId: null, summaryId: null, categories: { user: 12 }, parts: { user: { messages: 12 } }, totalTokens: 12, method: 'fixture', unmeasuredMedia: 0, unmeasuredProviderItems: 0 } } : {}),
    usage: { measurement: contextTokens === null ? 'missing' : 'actual', inputTokens: 40000, outputTokens: 1000, cachedInputTokens: 35000 } }]);
  const reader = new ThreadContextReader({ historyPage, historyItem, modelPresentations });
  const first = await reader.read('branch', '449');
  expect(first.counts).toEqual({ total: 450, user: 1, assistant: 1, tool: 448 });
  expect(first.contextRequest?.contextTokens).toBeNull();
  expect(historyItem.mock.calls.map(([reference]) => reference.id)).toEqual(['1']);
  expect(historyPage).toHaveBeenCalledTimes(2);
  contextTokens = 41000;
  expect((await reader.read('branch', '449')).contextRequest?.contextTokens).toBe(41000);
  expect(modelPresentations.mock.calls.map(call => call[2])).toEqual([true, false]);
  expect(historyPage).toHaveBeenCalledTimes(3);
  references.push({ ...references[0]!, id: '450', parent: '449', source: 'compaction' }); currentHead = 450;
  const compacted = await reader.read('branch', '450');
  expect(compacted.contextRequest).toBeNull();
  expect(compacted.latestRequest?.contextTokens).toBe(41000);
  expect(compacted.counts.total).toBe(451);
  references.push({ ...references[1]!, id: '451', parent: '450' }); currentHead = 451;
  expect((await reader.read('branch', '451')).contextRequest?.contextTokens).toBe(41000);
  currentHead = 1;
  expect((await reader.read('branch', '1')).counts).toEqual({ total: 2, user: 1, assistant: 1, tool: 0 });
  expect((await reader.read('branch', '0')).contextRequest).toBeNull();
  await expect(reader.read('branch', '451')).rejects.toThrow('no longer on this branch');
});
