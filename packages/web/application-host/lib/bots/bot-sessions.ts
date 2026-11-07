import type { BotSession, BotSummary, ThreadIdentity } from '@varin/application-client';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';

export function createBotSessions(getRuntime: () => Pick<AgentRuntimeClient, 'botScope' | 'thread' | 'createBotThread' | 'resolveBotEntry'>) {
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

  // The profile keeps its original identity. Catalog validates its ownership and
  // resolves or creates a usable entry in one transaction, including after GC.
  async function ensureEntry(bot: BotSummary): Promise<ThreadIdentity> {
    if (bot.entry.runtime !== 'agent') throw new Error('Agent Bot identity is required');
    const identity = await getRuntime().resolveBotEntry(bot.id, bot.entry.threadId, bot.entry.branchId);
    return { runtime: 'agent', ...identity };
  }

  return { ensureEntry, listSessions, createSession };
}
