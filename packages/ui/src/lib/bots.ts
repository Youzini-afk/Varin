import type { BotCreateInput, BotUpdateInput, BotModelSelection, BotReadyEntry, BotSummary, BotWorkItem, BotMemoryItem } from '@varin/application-client';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointWillChange } from '@varin/application-client';
import { create } from 'zustand';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { selectActiveWorkbenchProfile } from '@/lib/extensions/workbench-shell-transition';
import { VARIN_WORKBENCH_BOT_PROFILE_ID } from '@varin/extension-contract';
import { useUIStore } from '@/stores/useUIStore';

export type { BotModelSelection, BotSummary, BotWorkItem, BotReadyEntry } from '@varin/application-client';
const api = () => { const bots = getRegisteredRuntimeAPIs()?.bots; if (!bots) throw new Error('Bot service is unavailable'); return bots; };
export const listBots = (signal?: AbortSignal) => api().list(signal);
export const getBot = (id: string, signal?: AbortSignal) => api().get(id, signal);
export const createBot = (input: BotCreateInput = {}) => api().create(input);
export const updateBot = (id: string, patch: BotUpdateInput) => api().update(id, patch);
export const archiveBot = (id: string) => api().archive(id);
export const deleteBot = (id: string) => api().remove(id);
export const changeBotState = (id: string, action: 'sleep' | 'wake' | 'restore' | 'retry') => api().changeState(id, action);
export const listBotMemory = (id: string, signal?: AbortSignal) => api().memory.list(id, signal);
export const readBotMemorySource = (id: string, memoryId: number, signal?: AbortSignal) => api().memory.source(id, memoryId, signal);
export const updateBotMemory = (id: string, item: BotMemoryItem, action: 'correct' | 'forget', content?: string) => api().memory.update(id, item, action, content);
export const ensureBotEntry = (id: string, signal?: AbortSignal) => api().entry(id, signal);
export const listBotWork = (id: string, signal?: AbortSignal) => api().work(id, signal);

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
  const generation = getRuntimeEndpointGeneration();
  await selectActiveWorkbenchProfile(VARIN_WORKBENCH_BOT_PROFILE_ID, undefined, { enableShell: true });
  if (generation !== getRuntimeEndpointGeneration()) return;
  useUIStore.getState().setSettingsDialogOpen(false);
  await openBotConversation(bot.id, entry);
};
