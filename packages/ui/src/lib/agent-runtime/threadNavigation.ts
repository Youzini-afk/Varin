import { getRuntimeEndpointGeneration, type ThreadIdentity } from '@varin/application-client';
import { useThreadStore, threadComposerKey } from '@/stores/useThreadStore';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { noteSwitchDirection } from '@/lib/motion/switchDirection';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { resolveVarinWorkbenchLayout, VARIN_WORKBENCH_BOT_PROFILE_ID, VARIN_WORKBENCH_DEFAULT_PROFILE_ID } from '@varin/extension-contract';
import { getVarinExtensionCatalogState } from '@/lib/extensions/catalog-store';
import { selectActiveWorkbenchProfile } from '@/lib/extensions/workbench-shell-transition';
import { varinSurfaceRuntime } from '@/lib/extensions/surface-runtime';
import { getBot, openBotConversation } from '@/lib/bots';

let navigation = 0;
export const currentWorkbenchProfileId = (): string | null => {
  const workbench = getVarinExtensionCatalogState().snapshot?.workbench;
  return workbench?.authoritative ? resolveVarinWorkbenchLayout(workbench.document, { surface: varinSurfaceRuntime.surface, userId: 'default' }).profileId : null;
};
async function selectConversationShell(bot: boolean, assertCurrent: () => void, selectOnLeavingBot?: () => void): Promise<void> {
  const current = currentWorkbenchProfileId();
  if (bot && current !== VARIN_WORKBENCH_BOT_PROFILE_ID) await selectActiveWorkbenchProfile(VARIN_WORKBENCH_BOT_PROFILE_ID, undefined, { enableShell: true, beforeCommit: async () => assertCurrent() });
  else if (!bot && current === VARIN_WORKBENCH_BOT_PROFILE_ID) await selectActiveWorkbenchProfile(VARIN_WORKBENCH_DEFAULT_PROFILE_ID, undefined, { beforeCommit: async () => assertCurrent(), ...(selectOnLeavingBot ? { selectOnLeavingBot } : {}) });
}
export async function openExternalConversationFromNavigation(id: string): Promise<void> {
  const host = getRuntimeEndpointGeneration(), request = ++navigation;
  const current = () => { if (host !== getRuntimeEndpointGeneration() || request !== navigation) throw new Error('Conversation navigation was superseded'); };
  const { useExternalAgentStore } = await import('@/stores/useExternalAgentStore');
  current(); await selectConversationShell(false, current); current();
  useExternalAgentStore.getState().select(id);
  useUIStore.getState().setSettingsDialogOpen(false);
}
export async function openThreadFromNavigation(target: { threadId: string; branchId?: string; directory?: string | null }): Promise<ThreadIdentity> {
  const host = getRuntimeEndpointGeneration(); const request = ++navigation;
  const current = () => {
    if (host !== getRuntimeEndpointGeneration() || request !== navigation) throw new Error('Conversation navigation was superseded');
  };
  const { identity, botId, parentThreadId } = await useThreadStore.getState().resolveThread(target);
  current();
  const bot = botId ? await getBot(botId) : null;
  current();
  if (botId && (!bot || bot.id !== botId)) throw new Error('Conversation Bot is unavailable on this Host');
  // A Bot's own conversations stay in the Bot workbench. Its delegated work is an ordinary
  // execution Thread and opens where its files, terminals and collaboration live.
  const botConversation = Boolean(bot) && !parentThreadId;
  const select = () => { void useThreadStore.getState().selectThread(identity).catch(() => {}); };
  await selectConversationShell(botConversation, current, select);
  current();
  if (bot && botConversation) await openBotConversation(bot.id, identity, null, bot.archived);
  else {
    await useThreadStore.getState().selectThread(identity);
    current();
    if (target.directory) useDirectoryStore.getState().setDirectory(target.directory);
  }
  useUIStore.getState().setSettingsDialogOpen(false);
  useUIStore.getState().setActiveMainTab('chat');
  useUIStore.getState().closeMainSurfaces();
  return identity;
}
export async function startThreadFromNavigation(target: { directory?: string | null } = {}): Promise<string> {
  const host = getRuntimeEndpointGeneration(); const request = ++navigation;
  const current = () => { if (host !== getRuntimeEndpointGeneration() || request !== navigation) throw new Error('Conversation navigation was superseded'); };
  await selectConversationShell(false, current);
  current();
  const draftKey = useThreadStore.getState().openDraft({ workspacePath: target.directory ?? undefined });
  if (target.directory) useDirectoryStore.getState().setDirectory(target.directory);
  useUIStore.getState().setActiveMainTab('chat');
  useUIStore.getState().closeMainSurfaces();
  return draftKey;
}
/** Explicit submitters need a real Thread before admitting work. Navigation alone opens a draft. */
export async function createThreadForSubmission(target: { directory?: string | null } = {}): Promise<ThreadIdentity> {
  const draftKey = await startThreadFromNavigation(target);
  return useThreadStore.getState().materializeDraft(draftKey);
}
const navigableThreads = () => useThreadStore.getState().threads
  .filter(thread => !thread.bot_id && !thread.archived && thread.deleted_at_ms === null);
/** How many Threads relative navigation steps through; below two there is nowhere to go. */
export const navigableThreadCount = (): number => navigableThreads().length;
export async function switchRelativeThread(offset: number): Promise<void> {
  const { selectedIdentity } = useThreadStore.getState();
  const visible = navigableThreads()
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at_ms - a.updated_at_ms);
  if (!visible.length || !Number.isFinite(offset)) return;
  const index = visible.findIndex(thread => thread.thread_id === selectedIdentity?.threadId);
  const targetIndex = ((index + Math.trunc(offset)) % visible.length + visible.length) % visible.length;
  const target = visible[targetIndex];
  // A step that wraps around the list moves the other way on screen.
  noteSwitchDirection(index < 0 ? 0 : targetIndex - index);
  await openThreadFromNavigation({ threadId: target.thread_id });
}
export function appendThreadDraftText(identity: ThreadIdentity | string, text: string): void {
  const key = typeof identity === 'string' ? identity : threadComposerKey(useThreadStore.getState().hostKey, identity);
  useThreadDraftStore.getState().patch(key, draft => ({ text: [draft.text.trimEnd(), text].filter(Boolean).join('\n\n') }));
}
