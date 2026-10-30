import type { BotPresence, BotPresenceNeed, BotPresenceWork, BotSummary } from '@varin/application-client';
import type { Run } from '@varin/protocol';
import type { BotScopeView } from '../kernel/protocol.generated.js';

const ACTIVE: ReadonlySet<Run['state']> = new Set(['accepted', 'preparing', 'runnable', 'generating', 'executing', 'waiting']);

/** `permission` or `question` when the Run waits for the user; `active` for any other live Run. */
const runFact = (run: Run | null): 'permission' | 'question' | 'active' | null => {
  if (!run || !ACTIVE.has(run.state)) return null;
  if (run.state === 'waiting' && !run.cancel_requested) {
    if (run.waiting_on?.startsWith('permission:')) return 'permission';
    if (run.waiting_on?.startsWith('question:')) return 'question';
  }
  return 'active';
};

/**
 * What the Bot's figure needs from its execution scope: who waits for the user, which delegated
 * work is running and which of its own conversations is replying. Deleted threads are left out.
 */
export function projectBotPresence(bot: Pick<BotSummary, 'id' | 'name'>, scope: BotScopeView): BotPresence {
  const sessions = new Set(scope.sessions);
  const threads = new Map(scope.threads.map(thread => [thread.thread_id, thread] as const));
  const sessionOf = (threadId: string): string | null => {
    const seen = new Set<string>();
    for (let current: string | null = threadId; current && !seen.has(current); current = threads.get(current)?.parent_thread_id ?? null) {
      if (sessions.has(current)) return current;
      seen.add(current);
    }
    return null;
  };
  const needs: BotPresenceNeed[] = [];
  const working: BotPresenceWork[] = [];
  const replying: string[] = [];
  const ordered = [...scope.sessions.flatMap(id => threads.get(id) ?? []), ...scope.threads.filter(thread => !sessions.has(thread.thread_id))];
  for (const thread of ordered) {
    if (thread.deleted_at_ms !== null) continue;
    const session = sessions.has(thread.thread_id);
    for (const branch of thread.branches) {
      const fact = runFact(branch.latest_run);
      if (!fact) continue;
      const identity = { runtime: 'agent' as const, threadId: thread.thread_id, branchId: branch.branch_id };
      const name = session ? bot.name : thread.title || thread.thread_id;
      const avatar = session ? null : thread.avatar ?? null;
      if (fact !== 'active') needs.push({ identity, name, avatar, kind: fact, session });
      else if (session) { if (!replying.includes(thread.thread_id)) replying.push(thread.thread_id); }
      else working.push({ identity, name, avatar, sessionThreadId: sessionOf(thread.thread_id) });
    }
  }
  return { botId: bot.id, needs, working, replying };
}

export interface BotPresencePublisher {
  /** Recompute soon; repeated calls inside the delay collapse into one pass. */
  schedule(): void;
  dispose(): void;
}

/**
 * Recomputes every live Bot's presence after execution changes and publishes only the ones that
 * changed. A failed read publishes nothing, so clients keep the last projection they received.
 */
export function createBotPresencePublisher(options: {
  bots(): Promise<BotSummary[]>;
  scope(botId: string): Promise<BotScopeView>;
  publish(presence: BotPresence): void;
  onError(error: unknown): void;
  delayMs?: number;
}): BotPresencePublisher {
  const delay = options.delayMs ?? 250;
  const published = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;
  let disposed = false;
  const pass = async () => {
    const bots = (await options.bots()).filter(bot => !bot.archived && !bot.deletion);
    const live = new Set(bots.map(bot => bot.id));
    for (const id of [...published.keys()]) if (!live.has(id)) published.delete(id);
    for (const bot of bots) {
      if (disposed) return;
      try {
        const presence = projectBotPresence(bot, await options.scope(bot.id));
        const key = JSON.stringify(presence);
        if (disposed || published.get(bot.id) === key) continue;
        published.set(bot.id, key);
        options.publish(presence);
      } catch (error) { options.onError(error); }
    }
  };
  const run = () => {
    timer = null;
    if (running) { again = true; return; }
    running = true;
    void pass().catch(options.onError).finally(() => {
      running = false;
      if (again) { again = false; schedule(); }
    });
  };
  const schedule = () => {
    if (disposed || timer) return;
    timer = setTimeout(run, delay);
    (timer as { unref?: () => void }).unref?.();
  };
  return {
    schedule,
    dispose() { disposed = true; if (timer) clearTimeout(timer); timer = null; },
  };
}
