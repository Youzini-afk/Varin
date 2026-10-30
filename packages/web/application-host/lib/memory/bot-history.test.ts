import { expect, it, vi } from 'vitest';
import { createBotHistory } from './bot-history.js';

it('reads the actual incoming report and recent exchange without hydrating tool history', async () => {
  const items = [
    { id: 'user', thread_id: 'thread', source: 'user', content: 'Continue the release' },
    { id: 'assistant', thread_id: 'thread', source: 'assistant', content: { content: { kind: 'text', text: 'The release is awaiting builds.' } } },
    ...Array.from({ length: 40 }, (_, at) => ({ id: `tool${at}`, thread_id: 'thread', source: 'tool', content: 'irrelevant output' })),
    { id: 'report', thread_id: 'thread', source: 'agent', content: { content: { kind: 'output', output: { parts: [{ kind: 'text', text: 'The Android build finished.' }] } } } },
  ];
  const runtime = {
    thread: async () => ({ bot_id: 'bot', branches: [{ branch_id: 'main' }] }),
    historyPage: vi.fn(async () => ({ head: 'report', items, previous: null })),
    botHistory: vi.fn(async ({ itemId }: { itemId: string }) => items.find(item => item.id === itemId)),
  };
  const result = await createBotHistory(runtime as never).recent({ runtime: 'agent', threadId: 'thread', branchId: 'main' });
  expect(result.map(item => item.text)).toEqual(['Continue the release', 'The release is awaiting builds.', 'The Android build finished.']);
  expect(runtime.botHistory.mock.calls.map(([input]) => input.itemId)).toEqual(['report', 'assistant', 'user']);
});

it('uses each frozen branch boundary when collecting new memory sources', async () => {
  const runtime = {
    botScope: async () => ({ threads: [{ thread_id: 'thread', branches: [{ branch_id: 'main', head: 'new' }, { branch_id: 'done', head: 'old' }] }] }),
    botMatters: async () => [],
    thread: async () => ({ bot_id: 'bot', branches: [{ branch_id: 'main' }, { branch_id: 'done' }] }),
    historyPage: vi.fn(async () => ({ head: 'new', items: [{ id: 'new', thread_id: 'thread', source: 'user' }], previous: null })),
    botHistory: async () => ({ source: 'user', content: 'A new decision' }),
  };
  const result = await createBotHistory(runtime as never).botBatch('bot', { main: 'old', done: 'old' });
  expect(runtime.historyPage).toHaveBeenCalledExactlyOnceWith({ branchId: 'main', headId: 'new', afterId: 'old', limit: 100 }, undefined);
  expect(result.heads).toEqual({ main: 'new', done: 'old' });
  expect(result.materials.map(item => item.text)).toEqual(['A new decision']);
});

it('hydrates a model-sized tail and advances only the actually read metadata boundary', async () => {
  const items = ['one', 'two', 'three'].map(id => ({ id, thread_id: 'thread', source: 'user' }));
  const runtime = {
    botScope: vi.fn(async () => ({ threads: [{ thread_id: 'thread', branches: [{ branch_id: 'main', head: 'three' }] }] })),
    botMatters: async () => [],
    historyPage: vi.fn(async ({ afterId }: { afterId?: string }) => ({ head: 'three', items: afterId ? items.slice(items.findIndex(item => item.id === afterId) + 1) : items, previous: null })),
    botHistory: vi.fn(async ({ itemId }: { itemId: string }) => ({ source: 'user', content: `${itemId} and its original context` })),
  };
  const history = createBotHistory(runtime as never);
  const first = await history.botBatch('bot', {}, undefined, 10);
  expect(first.heads).toEqual({ main: 'one' });
  expect(first.hasMore).toBe(true);
  expect(runtime.botHistory).toHaveBeenCalledTimes(1);
  const next = await history.botBatch('bot', first.heads, undefined, 10);
  expect(next.heads).toEqual({ main: 'two' });
  expect(runtime.botHistory.mock.calls.map(([input]) => input.itemId)).toEqual(['one', 'two']);
  expect(runtime.botScope).toHaveBeenCalledWith('bot', undefined, true);
});
