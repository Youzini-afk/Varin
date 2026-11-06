import { expect, it } from 'vitest';
import type { BotSummary } from '@varin/application-client';
import type { ThreadSummary } from '@varin/protocol';
import { createBotSessions } from './bot-sessions.js';

it('opens an active Bot conversation when its original entry is archived or deleted', async () => {
  const bot: BotSummary = {
    id: 'bot', name: 'Varin', coordinatorHostId: 'host', homeDir: '/bots/bot', revision: 1,
    createdAt: '', updatedAt: '', archived: false, instructions: null, model: null,
    entry: { runtime: 'agent', threadId: 'original', branchId: 'original-main' },
  };
  const catalog = new Map<string, ThreadSummary>();
  const runtime = {
    thread: async (threadId: string) => {
      const thread = catalog.get(threadId);
      if (!thread) throw new Error('Unknown thread');
      return thread;
    },
    botScope: async () => ({ botId: bot.id, sessions: [...catalog.keys()], threads: [...catalog.values()], runs: [] }),
    createBotThread: async (_botId: string, threadId: string, branchId: string) => {
      if (catalog.has(threadId)) return { threadId, branchId };
      catalog.set(threadId, {
        thread_id: threadId, main_branch_id: branchId, bot_id: bot.id, parent_thread_id: null,
        title: 'New thread', revision: 1, created_at_ms: 0, updated_at_ms: 0, pinned: false, archived: false,
        deleted_at_ms: null, activity_cursor: 0, read_cursor: 0, unread: false, observer_project_ids: [],
        branches: [{ branch_id: branchId, head: null, active_run_id: null, latest_run: null }],
      });
      return { threadId, branchId };
    },
  };
  const sessions = createBotSessions(() => runtime);
  expect(await sessions.ensureEntry(bot)).toEqual(bot.entry);
  const original = catalog.get(bot.entry.threadId)!;
  original.archived = true;
  expect((await sessions.listSessions(bot)).find(session => session.primary)?.thread.archived).toBe(true);

  const other = await sessions.createSession(bot, { runtime: 'agent', threadId: 'other', branchId: 'other-main' });
  expect(await sessions.ensureEntry(bot)).toEqual(other.identity);
  original.deleted_at_ms = 1;
  catalog.get(other.identity.threadId)!.deleted_at_ms = 2;
  expect(await sessions.listSessions(bot)).toEqual([]);
  const next = await sessions.ensureEntry(bot);
  expect(next.threadId).not.toBe(original.thread_id);
  expect(await createBotSessions(() => runtime).ensureEntry(bot)).toEqual(next);
  expect(catalog.size).toBe(3);
});
