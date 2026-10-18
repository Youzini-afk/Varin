import { expect, it, vi } from 'vitest';
import type { HistoryReference } from '@varin/protocol';
import { HistoryRunNavigationReader } from './history-run-navigation.js';

it('indexes whole Runs without bodies, extends the index and validates a cached cut after rewind', async () => {
  const references: HistoryReference[] = Array.from({ length: 450 }, (_, index) => ({ id: `${index}`, parent: index ? `${index - 1}` : null,
    thread_id: 'thread', run_id: index < 300 ? 'first' : 'second', source: index === 0 || index === 100 || index === 300 ? 'user' : 'assistant', content_ref: `content:${index}` }));
  let currentHead = 449;
  const historyPage = vi.fn(async ({ headId, beforeId, limit }: { headId?: string; beforeId?: string; limit?: number }) => {
    const head = Number(headId);
    if (head > currentHead) throw new Error('history anchor is no longer on this branch');
    const end = beforeId ? Number(beforeId) : head + 1;
    const start = Math.max(0, end - limit!);
    return { head: headId!, previous: start ? `${start}` : null, items: references.slice(start, end) };
  });
  const historyItem = vi.fn(async (reference: HistoryReference) => ({ ...reference, provider: null,
    content: reference.source === 'user' ? { text: `Question for ${reference.run_id}` } : { content: { kind: 'text', text: `Complete answer ${reference.id}` } } }));
  const reader = new HistoryRunNavigationReader({ historyPage, historyItem });
  const index = await reader.read('branch', '449');
  expect(index.runs).toEqual([{ runId: 'first', firstItemId: '0', lastItemId: '299' }, { runId: 'second', firstItemId: '300', lastItemId: '449' }]);
  expect(historyPage).toHaveBeenCalledTimes(2);
  expect(historyItem).not.toHaveBeenCalled();
  expect(await reader.preview('branch', '449', 'first')).toBe('Complete answer 299');
  expect(historyItem.mock.calls.map(([reference]) => reference.id)).toEqual(['0', '299']);
  currentHead = 100;
  expect((await reader.read('branch', '100')).runs).toEqual([{ runId: 'first', firstItemId: '0', lastItemId: '100' }]);
  await expect(reader.read('branch', '449')).rejects.toThrow('no longer on this branch');
});
