import { runtimeFetch } from '@varin/application-client';
import type { SessionSnapshot, Thread, ThreadRun } from '@varin/protocol';
import { openPiSessionFromNavigation } from '@/lib/pi-runtime/sessionNavigation';

/** Durable Bot profile served by the Host bot catalog (BC0). */
export interface BotSummary {
  id: string;
  name: string;
  instructions: string | null;
  model: { providerId: string; modelId: string } | null;
  coordinatorHostId: string;
  homeDir: string;
  entrySessionId: string | null;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

const readJson = async <T>(response: Response, fallback: string): Promise<T> => {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message = typeof body?.error === 'string' ? body.error : fallback;
    throw new Error(message);
  }
  return response.json() as Promise<T>;
};

export const listBots = async (): Promise<BotSummary[]> => {
  const result = await readJson<{ bots: BotSummary[] }>(
    await runtimeFetch('/api/harness/bots'),
    'Unable to list bots',
  );
  return result.bots;
};

export const createBot = async (input: { name?: string; instructions?: string } = {}): Promise<BotSummary> => {
  const result = await readJson<{ bot: BotSummary }>(
    await runtimeFetch('/api/harness/bots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
    'Unable to create the bot',
  );
  return result.bot;
};

/** Resolve (creating when necessary) the Bot's durable entry session id. */
export const ensureBotEntry = async (botId: string): Promise<{ bot: BotSummary; sessionId: string }> => (
  readJson<{ bot: BotSummary; sessionId: string }>(
    await runtimeFetch(`/api/harness/bots/${encodeURIComponent(botId)}/entry`, { method: 'POST' }),
    'Unable to open the bot entry',
  )
);

export const listBotWork = async (botId: string): Promise<Array<{ thread: Thread; activeRun: ThreadRun | null }>> => {
  const result = await readJson<{ threads: Array<{ thread: Thread; activeRun: ThreadRun | null }> }>(
    await runtimeFetch(`/api/harness/bots/${encodeURIComponent(botId)}/work`),
    'Unable to list bot work',
  );
  return result.threads;
};

/**
 * The Bot entry point: resolve the first active Bot (creating one on first
 * use), open its durable entry session, and navigate to it. Reopening always
 * lands on the same conversation — the Bot's work association lives on its
 * scope, not on the session lifecycle.
 */
export const openBotEntry = async (): Promise<SessionSnapshot> => {
  const bots = await listBots();
  const existing = bots.find((candidate) => !candidate.archived);
  const { bot, sessionId } = await ensureBotEntry((existing ?? await createBot()).id);
  return openPiSessionFromNavigation({ sessionId, directory: bot.homeDir });
};
