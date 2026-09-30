import { runtimeFetch } from '@varin/application-client';
import type { BotModelSelection, BotSummary, BotWorkItem, BotMemoryItem } from '@varin/application-client';
import type { MemorySourceExcerpt } from '@varin/protocol';
import type { SessionSnapshot } from '@varin/protocol';
import { openPiSessionFromNavigation } from '@/lib/pi-runtime/sessionNavigation';
import { selectActiveWorkbenchProfile } from '@/lib/extensions/workbench-shell-transition';
import { VARIN_WORKBENCH_BOT_PROFILE_ID } from '@varin/extension-contract';
import { useUIStore } from '@/stores/useUIStore';

export type { BotModelSelection, BotSummary, BotWorkItem } from '@varin/application-client';

const readJson = async <T>(response: Response, fallback: string): Promise<T> => {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message = typeof body?.error === 'string' ? body.error : fallback;
    throw new Error(message);
  }
  return response.json() as Promise<T>;
};

export const listBots = async (signal?: AbortSignal): Promise<BotSummary[]> => {
  const result = await readJson<{ bots: BotSummary[] }>(
    await runtimeFetch('/api/harness/bots', { signal }),
    'Unable to list bots',
  );
  return result.bots;
};

export const getBot = async (botId: string): Promise<BotSummary | null> => {
  const result = await readJson<{ bot: BotSummary | null }>(
    await runtimeFetch(`/api/harness/bots/${encodeURIComponent(botId)}`),
    'Unable to load the bot',
  );
  return result.bot;
};

export const createBot = async (input: {
  name?: string;
  instructions?: string;
  model?: BotModelSelection;
} = {}): Promise<BotSummary> => {
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

export const updateBot = async (botId: string, patch: {
  name?: string;
  instructions?: string | null;
  model?: BotModelSelection | null;
  pinned?: boolean;
}): Promise<BotSummary> => {
  const result = await readJson<{ bot: BotSummary }>(
    await runtimeFetch(`/api/harness/bots/${encodeURIComponent(botId)}/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
    'Unable to update the bot',
  );
  return result.bot;
};

export const archiveBot = async (botId: string): Promise<BotSummary> => {
  const result = await readJson<{ bot: BotSummary }>(
    await runtimeFetch(`/api/harness/bots/${encodeURIComponent(botId)}/archive`, { method: 'POST' }),
    'Unable to archive the bot',
  );
  return result.bot;
};

export const changeBotState = async (botId: string, action: 'sleep' | 'wake' | 'restore' | 'retry'): Promise<BotSummary> => {
  const result = await readJson<{ bot: BotSummary }>(await runtimeFetch(`/api/harness/bots/${encodeURIComponent(botId)}/${action}`, { method: 'POST' }), 'Unable to change Bot state');
  return result.bot;
};
export const listBotMemory = async (botId: string, signal?: AbortSignal): Promise<BotMemoryItem[]> => (
  await readJson<{ items: BotMemoryItem[] }>(await runtimeFetch(`/api/harness/bots/${encodeURIComponent(botId)}/memory`, { signal }), 'Unable to read Bot memory')
).items;
export const readBotMemorySource = async (botId: string, id: number): Promise<MemorySourceExcerpt[]> => (
  await readJson<{ sources: MemorySourceExcerpt[] }>(await runtimeFetch(`/api/harness/bots/${encodeURIComponent(botId)}/memory/${id}/source`), 'Unable to read memory sources')
).sources;
export const updateBotMemory = async (botId: string, item: BotMemoryItem, action: 'correct' | 'forget', content?: string): Promise<void> => {
  await readJson(await runtimeFetch(`/api/harness/bots/${encodeURIComponent(botId)}/memory/${item.id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, revision: item.revision, content }),
  }), 'Unable to update Bot memory');
};

/** Resolve (creating when necessary) the Bot's durable entry session id. */
export const ensureBotEntry = async (botId: string, signal?: AbortSignal): Promise<{ bot: BotSummary; sessionId: string }> => (
  readJson<{ bot: BotSummary; sessionId: string }>(
    await runtimeFetch(`/api/harness/bots/${encodeURIComponent(botId)}/entry`, { method: 'POST', signal }),
    'Unable to open the bot entry',
  )
);

export const listBotWork = async (botId: string, signal?: AbortSignal): Promise<BotWorkItem[]> => {
  const result = await readJson<{ threads: BotWorkItem[] }>(
    await runtimeFetch(`/api/harness/bots/${encodeURIComponent(botId)}/work`, { signal }),
    'Unable to list bot work',
  );
  return result.threads;
};

/** Open the Bot's durable entry conversation for this specific Bot. */
export const openBotEntryFor = async (botId: string): Promise<SessionSnapshot> => {
  const { bot, sessionId } = await ensureBotEntry(botId);
  await selectActiveWorkbenchProfile(VARIN_WORKBENCH_BOT_PROFILE_ID, undefined, { enableShell: true });
  useUIStore.getState().setSettingsDialogOpen(false);
  return openPiSessionFromNavigation({ sessionId, directory: bot.homeDir });
};
