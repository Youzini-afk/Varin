import type { BotCreateInput, BotUpdateInput, BotModelSelection, BotReadyEntry, BotSummary, BotWorkItem, BotMemoryItem } from '@varin/application-client';
import { createScheduledTasksHttpAPI, getRuntimeEndpointGeneration, subscribeRuntimeEndpointWillChange } from '@varin/application-client';
import { create } from 'zustand';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { selectActiveWorkbenchProfile } from '@/lib/extensions/workbench-shell-transition';
import { VARIN_WORKBENCH_BOT_PROFILE_ID } from '@varin/extension-contract';
import { useUIStore } from '@/stores/useUIStore';

export type { BotModelSelection, BotSummary, BotWorkItem, BotReadyEntry, BotSession, BotMemoryItem } from '@varin/application-client';
const api = () => { const bots = getRegisteredRuntimeAPIs()?.bots; if (!bots) throw new Error('Bot service is unavailable'); return bots; };
const schedules = createScheduledTasksHttpAPI();
export const listBots = (signal?: AbortSignal) => api().list(signal);
export const ensurePrimaryBot = (signal?: AbortSignal) => api().primary(signal);
export const getBot = (id: string, signal?: AbortSignal) => api().get(id, signal);
export const createBot = (input: BotCreateInput = {}) => api().create(input);
export const updateBot = (id: string, patch: BotUpdateInput) => api().update(id, patch);
export const archiveBot = (id: string) => api().archive(id);
export const deleteBot = (id: string) => api().remove(id);
export const changeBotState = (id: string, action: 'sleep' | 'wake' | 'restore' | 'retry') => api().changeState(id, action);
export const listBotMemory = (id: string, signal?: AbortSignal, includeInactive?: boolean) => api().memory.list(id, signal, includeInactive);
export const readBotMemoryHistory = (id: string, memoryId: number, signal?: AbortSignal) => api().memory.history(id, memoryId, signal);
export const readBotMemorySource = (id: string, memoryId: number, signal?: AbortSignal) => api().memory.source(id, memoryId, signal);
export const updateBotMemory = (id: string, item: BotMemoryItem, action: 'correct' | 'forget' | 'archive', content?: string) => api().memory.update(id, item, action, content);
export const ensureBotEntry = (id: string, signal?: AbortSignal) => api().entry(id, signal);
export const listBotWork = (id: string, signal?: AbortSignal) => api().work(id, signal);
export const listBotSessions = (id: string, signal?: AbortSignal) => api().sessions.list(id, signal);
export const createBotSession = (id: string) => api().sessions.create(id);
export const listBotMatters = (id: string, signal?: AbortSignal) => api().matters.list(id, signal);
/** The Bot's Calendar tasks live under its `bot:<id>` asset namespace (docs/bot.md). */
export const listBotSchedules = (id: string, signal?: AbortSignal) => schedules.list(`bot:${id}`, signal);

/**
 * Where the user left the Bot when they opened its delegated work in the ordinary workbench.
 * Only presentation state: the back control returns to this conversation and reading position.
 */
export interface BotReturnPoint {
  botId: string;
  botName: string;
  session: BotReadyEntry;
  sessionTitle: string;
  workThreadId: string;
  /** The panel row the user left from, lit again on return. */
  focus?: { tab: 'overview' | 'activity' | 'memory' | 'schedule'; id: string };
}
/** `returned` is the point the user just came back through, until the Bot shell has shown it. */
export const useBotReturn = create<{ point: BotReturnPoint | null; returned: BotReturnPoint | null }>(() => ({ point: null, returned: null }));
subscribeRuntimeEndpointWillChange(() => useBotReturn.setState({ point: null, returned: null }));

/** View selection only. Identities are always returned by the Host. */
export const useBotNavigation = create<{ botId: string | null; entry: BotReadyEntry | null; model: BotModelSelection | null; archived?: boolean }>(() => ({ botId: null, entry: null, model: null }));
subscribeRuntimeEndpointWillChange(() => useBotNavigation.setState({ botId: null, entry: null, model: null }));
export const botWorkId = (item: BotWorkItem) => JSON.stringify([item.identity.threadId, item.identity.branchId]);
export const botWorkTitle = (item: BotWorkItem) => item.thread.title || item.identity.threadId;
export const botWorkEntry = (item: BotWorkItem): BotReadyEntry => item.identity;
export const sameBotEntry = (a: BotReadyEntry | null | undefined, b: BotReadyEntry | null | undefined) => Boolean(a && b && a.threadId === b.threadId && a.branchId === b.branchId);
export const openBotConversation = async (botId: string, entry: BotReadyEntry, directory?: string, model: BotModelSelection | null = null, archived?: boolean): Promise<void> => {
  // Bot work has a separate presentation selection; ordinary Thread navigation remains intact.
  if (directory) useDirectoryStore.getState().setDirectory(directory, { showOverlay: false });
  useBotNavigation.setState({ botId, entry, model, archived });
};
export const openBotEntryFor = async (botId: string): Promise<void> => {
  const generation = getRuntimeEndpointGeneration();
  const { bot, entry, model } = await ensureBotEntry(botId);
  await selectActiveWorkbenchProfile(VARIN_WORKBENCH_BOT_PROFILE_ID, undefined, { enableShell: true });
  if (generation !== getRuntimeEndpointGeneration()) return;
  useUIStore.getState().setSettingsDialogOpen(false);
  await openBotConversation(bot.id, entry, bot.homeDir, model);
};
export const openBotWorkFor = async (bot: BotSummary, work: BotWorkItem): Promise<void> => {
  const entry = botWorkEntry(work); if (!entry) return;
  if (work.purpose === 'work' || work.purpose === 'followed') {
    const { openThreadFromNavigation } = await import('@/lib/agent-runtime/threadNavigation');
    await openThreadFromNavigation(entry);
    return;
  }
  const generation = getRuntimeEndpointGeneration();
  await selectActiveWorkbenchProfile(VARIN_WORKBENCH_BOT_PROFILE_ID, undefined, { enableShell: true });
  if (generation !== getRuntimeEndpointGeneration()) return;
  useUIStore.getState().setSettingsDialogOpen(false);
  await openBotConversation(bot.id, entry);
};
/** Open delegated work in the ordinary workbench and remember the Bot conversation to return to. */
export const openBotWorkInWorkbench = async (point: BotReturnPoint, work: BotReadyEntry): Promise<void> => {
  useBotReturn.setState({ point });
  const { openThreadFromNavigation } = await import('@/lib/agent-runtime/threadNavigation');
  await openThreadFromNavigation(work);
};
/** Return from delegated work to the Bot conversation that dispatched it. */
export const returnToBot = async (point: BotReturnPoint): Promise<void> => {
  const generation = getRuntimeEndpointGeneration();
  await selectActiveWorkbenchProfile(VARIN_WORKBENCH_BOT_PROFILE_ID, undefined, { enableShell: true });
  if (generation !== getRuntimeEndpointGeneration()) return;
  useUIStore.getState().setSettingsDialogOpen(false);
  await openBotConversation(point.botId, point.session);
  useBotReturn.setState({ point: null, returned: point });
};
