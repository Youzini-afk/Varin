import { expect, it, vi } from 'vitest';
import type { HistoryReference } from '@varin/protocol';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import { createFragmentHistory } from './fragment-history.js';

const ref = (id: string) => ({ id, source: 'assistant', content_ref: id } as HistoryReference);
it('shares ancestry reads and original bodies, reuses proven suffixes and rejects a rewound-away message', async () => {
  const recent = ref('recent'), old = ref('old');
  const runtime = { historyPage: vi.fn().mockResolvedValueOnce({ head: 'recent', items: [recent], previous: 'recent' })
    .mockResolvedValueOnce({ head: 'recent', items: [old], previous: null }), historyItem: vi.fn(async (item: HistoryReference) => ({ id: item.id })) };
  const lookup = createFragmentHistory(runtime as unknown as AgentRuntimeClient);
  const [a, b] = await Promise.all([lookup.find('thread', 'main', 'recent', 'old'), lookup.find('thread', 'main', 'recent', 'old')]);
  expect(a).toBe(old); expect(b).toBe(old); expect(runtime.historyPage).toHaveBeenCalledTimes(2);
  await Promise.all([lookup.body(a!), lookup.body(b!)]); expect(runtime.historyItem).toHaveBeenCalledTimes(1);
  runtime.historyPage.mockResolvedValueOnce({ head: 'new', items: [ref('new'), recent], previous: 'recent' });
  expect(await lookup.find('thread', 'main', 'new', 'old')).toBe(old); expect(runtime.historyPage).toHaveBeenCalledTimes(3);
  runtime.historyPage.mockResolvedValueOnce({ head: 'old', items: [old], previous: null });
  expect(await lookup.find('thread', 'main', 'old', 'recent')).toBeUndefined();
  runtime.historyPage.mockResolvedValueOnce({ head: 'other', items: [ref('other')], previous: null });
  expect(await lookup.find('thread', 'fork', 'other', 'old')).toBeUndefined();
});
