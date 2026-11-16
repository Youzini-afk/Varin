import type { ThreadIdentity } from '@varin/application-client';
import { toast } from '@/components/ui';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { useUIStore } from '@/stores/useUIStore';
import { currentWorkbenchProfileId, openThreadFromNavigation } from './agent-runtime/threadNavigation';
import { VARIN_WORKBENCH_BOT_PROFILE_ID } from '@varin/extension-contract';
import { useBotNavigation } from './bots';
import { BOT_CONVERSATION_PANEL_SCOPE } from './openConversationTree';

export function openCollaborationMember(source: ThreadIdentity, member: ThreadIdentity): void {
  const bot = currentWorkbenchProfileId() === VARIN_WORKBENCH_BOT_PROFILE_ID;
  const current = bot ? useBotNavigation.getState().entry : useThreadStore.getState().selectedIdentity;
  if (current?.threadId !== source.threadId || current.branchId !== source.branchId) {
    // A secondary history view can link to a child of a different route.
    void openThreadFromNavigation(member).catch(error => toast.error(String(error)));
    return;
  }
  const directory = bot ? BOT_CONVERSATION_PANEL_SCOPE : useDirectoryStore.getState().currentDirectory;
  useUIStore.getState().openContextPanelTab(directory, { mode: 'threads', thread: source, member });
}
