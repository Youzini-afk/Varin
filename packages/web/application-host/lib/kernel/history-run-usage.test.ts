import { expect, it, vi } from 'vitest';
import type { ThreadHistoryPage } from '@varin/application-client';
import type { HistoryItem, ModelPresentation } from '@varin/protocol';
import { HistoryRunUsageReader } from './history-run-usage.js';

it('reads an ended run through the anchored cut, deduplicates requests and refreshes late receipts', async () => {
  const item = (id: string, request: string, runId = 'run'): HistoryItem => ({ id, run_id: runId, thread_id: 'thread', parent: null,
    source: 'assistant', provider: null, content: { id: `model-item:${Buffer.byteLength(request)}:${request}:part`, content: { kind: 'text', text: id } } });
  const current = [item('recent:1', 'second'), item('recent:2', 'second')];
  const earlier = [item('boundary', 'unrelated', 'older-run'), item('first:1', '请求'), item('first:2', '请求')];
  const presentation = (requestId: string, outputTokens: number): ModelPresentation => ({ requestId, providerFamily: 'openai-completions', modelId: 'model',
    usage: { measurement: 'actual', inputTokens: 100, outputTokens, cachedInputTokens: null, cacheWriteTokens: null, reasoningTokens: null, pricingVersion: null } });
  let state = 'waiting', output = 3;
  const historyPage = vi.fn(async () => ({ head: 'view:cut', previous: null,
    items: earlier.map(value => ({ id: value.id, run_id: value.run_id, thread_id: value.thread_id, parent: value.parent, source: value.source, content_ref: value.id })) }));
  const historyItem = vi.fn(async (reference: { id: string }) => earlier.find(value => value.id === reference.id)!);
  const modelPresentations = vi.fn(async (ids: string[]) => ids.map(id => presentation(id, output)));
  const reader = new HistoryRunUsageReader({ run: async (id: string) => ({ id, state }), historyPage, historyItem, modelPresentations } as unknown as ConstructorParameters<typeof HistoryRunUsageReader>[0]);
  const page: ThreadHistoryPage = { head: 'view:cut', previous: current[0]!.id, items: current };
  expect(await reader.read('branch', page, [presentation('second', 5)])).toEqual([]);
  expect(historyPage).not.toHaveBeenCalled();
  state = 'completed';
  const first = await reader.read('branch', page, [presentation('second', 5)]);
  expect(first[0]!.requests.map(value => value.requestId)).toEqual(['second', '请求']);
  expect(historyPage).toHaveBeenCalledWith({ branchId: 'branch', headId: 'view:cut', beforeId: 'recent:1', limit: 256 }, undefined);
  expect(historyItem.mock.calls.map(([value]) => value.id)).toEqual(['first:2', 'first:1']);
  expect(first[0]!.requests.find(value => value.requestId === '请求')?.usage.outputTokens).toBe(3);
  output = 7;
  const refreshed = await reader.read('branch', page, [presentation('second', 5)]);
  expect(refreshed[0]!.requests.find(value => value.requestId === '请求')?.usage.outputTokens).toBe(7);
  expect(historyPage).toHaveBeenCalledTimes(1);
});
