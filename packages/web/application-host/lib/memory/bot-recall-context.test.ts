import { expect, it, vi } from 'vitest';
import { createBotRecallContext } from './bot-recall-context.js';
import { createKnowledgeContextRuntime } from '../knowledge/context-runtime.js';

it('uses incoming work to select its matter and project without pinning unrelated Bot tasks', async () => {
  const rows = [
    { thread_id: 'bot', parent_thread_id: null, observer_project_ids: [] },
    { thread_id: 'release', parent_thread_id: 'bot', observer_project_ids: ['project'] },
    { thread_id: 'paper', parent_thread_id: 'bot', observer_project_ids: [] },
  ];
  const matters = [
    { id: 'publish', revision: 1, title: 'Signed release', description: 'Wait for approval from the signing owner.', archived: false,
      threads: [{ threadId: 'release', branchId: 'main', memory: true }, { threadId: 'followed', branchId: 'main', memory: false }] },
    { id: 'study', revision: 1, title: 'Paper', description: 'Independent unrelated work.', archived: false, threads: [{ threadId: 'paper', branchId: 'main', memory: true }] },
  ];
  const prepare = createBotRecallContext({ runtime: { thread: async () => ({ bot_id: 'bot', parent_thread_id: null }),
    botScope: async () => ({ threads: rows }), botMatters: async () => matters } as never,
    projects: async () => [{ id: 'project', path: '/release', label: 'Product release' }] });
  const result = await prepare({ threadId: 'bot', query: 'Good, continue.', work: [{ threadId: 'release', branchId: 'main' }] });
  expect(result.query).toContain('signing owner');
  expect(result.query).toContain('Product release');
  expect(result.query).not.toContain('Independent unrelated');
  expect(result.associated.threadIds).toEqual(['release']);
  expect((await prepare({ threadId: 'bot', query: 'Unrelated question' })).associated.threadIds).toEqual([]);
  expect((await prepare({ threadId: 'bot', query: 'Read the newspaper' })).associated.threadIds).toEqual([]);
  matters[0]!.revision++;
  expect((await prepare({ threadId: 'bot', query: 'Good, continue.', work: [{ threadId: 'release' }] })).revision).not.toEqual(result.revision);
});

it('invalidates a same-text recall when original matter associations change', async () => {
  let revision = 'first';
  const recalled = vi.fn(async (_input: Record<string, unknown>) => []);
  const context = createKnowledgeContextRuntime({ getStore: async () => ({ knowledgeRevision: () => 'same' }) as never,
    recallContextForThread: async ({ query }) => ({ query, revision, associated: { threadIds: [revision] } }), recallForThread: recalled });
  const request = { threadId: 'bot', scopeId: 'bot:owner', query: 'continue' };
  await context.knowledgeForThread(request); await context.knowledgeForThread(request);
  expect(recalled).toHaveBeenCalledTimes(1);
  revision = 'changed';
  await context.knowledgeForThread(request);
  expect(recalled).toHaveBeenCalledTimes(2);
  expect(recalled.mock.calls.at(-1)?.[0]).toMatchObject({ associated: { threadIds: ['changed'] } });
  await context.dispose();
});
