import { freezeProjectSourceSelection } from '@varin/application-client';
import { getRuntimeEndpointGeneration, projectResourceOwnerKey, projectContainsPath, type ThreadIdentity } from '@varin/application-client';
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
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import type { ConversationOrganizationPlacement } from '@varin/application-client';
import type { DraftSourceSelection } from '@/stores/useThreadDraftStore';

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
  const surface = useUIStore.getState().mainSurfaceSelectionRevision;
  const current = () => { if (host !== getRuntimeEndpointGeneration() || request !== navigation || surface !== useUIStore.getState().mainSurfaceSelectionRevision) throw new Error('Conversation navigation was superseded'); };
  const { useExternalAgentStore } = await import('@/stores/useExternalAgentStore');
  current(); await selectConversationShell(false, current); current();
  useExternalAgentStore.getState().select(id);
  useUIStore.getState().setSettingsDialogOpen(false);
}
export async function openThreadFromNavigation(target: { threadId: string; branchId?: string; directory?: string | null }): Promise<ThreadIdentity> {
  const host = getRuntimeEndpointGeneration(); const request = ++navigation;
  const surface = useUIStore.getState().mainSurfaceSelectionRevision;
  const current = () => {
    if (host !== getRuntimeEndpointGeneration() || request !== navigation || surface !== useUIStore.getState().mainSurfaceSelectionRevision) throw new Error('Conversation navigation was superseded');
  };
  const { identity, botId, parentThreadId } = await useThreadStore.getState().resolveThread(target);
  current();
  const botConversation = Boolean(botId) && !parentThreadId;
  // Direct Bot conversations are the same Thread in every Shell. A chosen workbench/IDE
  // is not replaced merely because its navigation target happens to belong to a Bot.
  const inBotShell = currentWorkbenchProfileId() === VARIN_WORKBENCH_BOT_PROFILE_ID;
  if (botConversation && inBotShell) {
    const bot = await getBot(botId!); current();
    await useThreadStore.getState().selectThread(identity); current();
    await openBotConversation(botId!, identity, bot?.model ?? null, bot?.archived);
  } else {
    const select = () => { void useThreadStore.getState().selectThread(identity).catch(() => {}); };
    if (inBotShell) await selectConversationShell(false, current, select);
    current();
    await useThreadStore.getState().selectThread(identity);
    current();
    if (target.directory) useDirectoryStore.getState().setDirectory(target.directory);
  }
  useUIStore.getState().setSettingsDialogOpen(false);
  useUIStore.getState().setActiveMainTab('chat');
  useUIStore.getState().closeMainSurfaces();
  return identity;
}
export interface NewConversationTarget {
  directory?: string | null; projectId?: string; organization?: ConversationOrganizationPlacement;
  sourceSelection?: DraftSourceSelection; botId?: string;
  /** Set only for a worktree returned by the original project Git owner.
   * Retains model/project metadata, not filesystem authority. */
  worktreeProject?: boolean;
}
export async function startThreadFromNavigation(target: NewConversationTarget = {}): Promise<string> {
  const host = getRuntimeEndpointGeneration(); const request = ++navigation;
  const surface = useUIStore.getState().mainSurfaceSelectionRevision;
  const current = () => { if (host !== getRuntimeEndpointGeneration() || request !== navigation || surface !== useUIStore.getState().mainSurfaceSelectionRevision) throw new Error('Conversation navigation was superseded'); };
  if (!(target.botId && currentWorkbenchProfileId() === VARIN_WORKBENCH_BOT_PROFILE_ID)) await selectConversationShell(false, current);
  current();
  const project = target.projectId ? useProjectsStore.getState().projects.find(project => project.id === target.projectId) : undefined;
  if (target.projectId && !project) throw new Error('The selected project is no longer registered');
  let organization = target.organization;
  if (!organization && project) {
    const api = getRegisteredRuntimeAPIs()?.conversationOrganization;
    if (!api) throw new Error('Conversation organization is unavailable');
    const directory = await api.read({ limit: 1 }); current();
    const container = directory.containers.find(container => container.kind === 'project' && container.projectId === project.id);
    if (!container) throw new Error('The project is registered but its conversation location is not ready');
    organization = { containerId: container.id };
  }
  // Copy defaults now rather than resolving the navigation tree again at first send.
  const path = target.sourceSelection?.path ?? target.directory ?? project?.path;
  const sourceSelection = target.sourceSelection ?? (project && path ? {
    resourceOwner: project.source?.resourceOwner ?? { kind: 'local' as const }, path,
    ...(project.source?.workspaceId && path === project.path ? { expectedWorkspaceId: project.source.workspaceId } : {}),
    ...(path === project.path ? { selection: freezeProjectSourceSelection(project) } : {selection: {mode:'live_root' as const}}),
    mode: path === project.path ? freezeProjectSourceSelection(project).mode : 'live_root' as const, contentMode: 'saved-files' as const, captureScopes: [],
  } : undefined);
  const remote = sourceSelection?.resourceOwner.kind === 'managed_host';
  const projectDefaultsApply = project && (!target.sourceSelection ||
    projectResourceOwnerKey(project) === projectResourceOwnerKey({ source: { resourceOwner: target.sourceSelection.resourceOwner, workspaceId: '' } })
    && (target.worktreeProject === true || projectContainsPath(project, target.sourceSelection.path)));
  const draftKey = useThreadStore.getState().openDraft({ workspacePath: remote ? undefined : path ?? undefined,
    ...(sourceSelection ? { sourceSelection: structuredClone(sourceSelection) } : {}),
    ...(organization ? { organization: { ...organization } } : {}),
    ...(projectDefaultsApply ? { projectId: project.id } : {}), ...(target.botId ? { botId: target.botId } : {}),
  });
  if (path && !remote) useDirectoryStore.getState().setDirectory(path);
  useUIStore.getState().setActiveMainTab('chat');
  useUIStore.getState().closeMainSurfaces();
  return draftKey;
}
/** Explicit submitters need a real Thread before admitting work. Navigation alone opens a draft. */
export async function createThreadForSubmission(target: NewConversationTarget = {}): Promise<ThreadIdentity> {
  const draftKey = await startThreadFromNavigation(target);
  return useThreadStore.getState().materializeDraft(draftKey);
}
const navigableThreads = () => useThreadStore.getState().threads
  .filter(thread => !thread.archived && thread.deleted_at_ms === null);
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
