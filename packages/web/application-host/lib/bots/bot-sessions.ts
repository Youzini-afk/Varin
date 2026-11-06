import { randomUUID } from 'node:crypto';
import type { BotSession, BotSummary, ThreadIdentity } from '@varin/application-client';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';

export function createBotSessions(getRuntime: () => Pick<AgentRuntimeClient, 'botScope' | 'thread' | 'createBotThread'>) {
  async function listSessions(bot: BotSummary): Promise<BotSession[]> {
    const scope = await getRuntime().botScope(bot.id, undefined, true);
    const threads = new Map(scope.threads.map(thread => [thread.thread_id, thread]));
    return scope.sessions.flatMap(threadId => {
      const thread = threads.get(threadId);
      return thread && thread.deleted_at_ms === null ? [{
        identity: { runtime: 'agent', threadId, branchId: thread.main_branch_id },
        thread,
        primary: threadId === bot.entry.threadId,
      }] : [];
    });
  }

  async function createSession(bot: BotSummary, identity: ThreadIdentity): Promise<BotSession> {
    const runtime = getRuntime();
    await runtime.createBotThread(bot.id, identity.threadId, identity.branchId);
    const thread = await runtime.thread(identity.threadId);
    return { identity: { runtime: 'agent', threadId: thread.thread_id, branchId: thread.main_branch_id }, thread, primary: false };
  }

  // The profile keeps its original identity. Resolve a usable conversation from
  // the Catalog each time the entry is opened, including after an app restart.
  // BotService serializes this with other session creation for the same Bot.
  async function ensureEntry(bot: BotSummary): Promise<ThreadIdentity> {
    if (bot.entry.runtime !== 'agent') throw new Error('Agent Bot identity is required');
    const runtime = getRuntime();
    // Creation is idempotent even for a tombstone. It also repairs a profile
    // saved before its initial conversation could be created.
    await runtime.createBotThread(bot.id, bot.entry.threadId, bot.entry.branchId);
    const original = await runtime.thread(bot.entry.threadId);
    if (original.deleted_at_ms === null && !original.archived) return bot.entry;

    const active = (await listSessions(bot)).filter(session => !session.thread.archived);
    active.sort((a, b) => b.thread.updated_at_ms - a.thread.updated_at_ms);
    if (active[0]) return active[0].identity;

    const id = randomUUID();
    return (await createSession(bot, {
      runtime: 'agent', threadId: `thread:bot:${bot.id}:${id}`, branchId: `branch:bot:${bot.id}:${id}`,
    })).identity;
  }

  return { ensureEntry, listSessions, createSession };
}
