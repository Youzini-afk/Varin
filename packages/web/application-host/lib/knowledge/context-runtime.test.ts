import { expect, it, vi } from 'vitest';
import { createKnowledgeContextRuntime } from './context-runtime.js';
import type { KnowledgeStore } from './store.js';

it('keeps Bot knowledge recall in its own owner without loading environmental journals', async () => {
  const recall = vi.fn(async () => []), store = { knowledgeRevision: () => 'revision:1', recall } as unknown as KnowledgeStore;
  const load = vi.fn(async () => store), context = createKnowledgeContextRuntime({ getStore: load });
  const request = { threadId: 'bot-thread', scopeId: 'bot:scope', query: 'release plan' };
  expect(await context.knowledgeForThread(request)).toEqual({ knowledge: [] });
  await context.knowledgeForThread(request);
  expect(recall).toHaveBeenCalledExactlyOnceWith('release plan', 5);
  expect(load).toHaveBeenCalledWith('bot:scope'); await context.dispose();
});
it('does not turn unavailable Bot knowledge into a fabricated empty store', async () => {
  const context = createKnowledgeContextRuntime({ getStore: async () => null });
  await expect(context.knowledgeForThread({ threadId: 'bot', scopeId: 'bot:scope', query: 'release' })).rejects.toThrow('Bot knowledge owner is unavailable');
  await context.dispose();
});
