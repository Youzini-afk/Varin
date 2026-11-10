import React from 'react';
import { VARIN_WORKBENCH_BOT_PROFILE_ID } from '@varin/extension-contract';
import type { ThreadIdentity } from '@varin/application-client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { BOT_CONVERSATION_PANEL_SCOPE } from './openConversationTree';
import { useWorkbenchProfileId } from './workbench/profile-context';

/** Route into the rendered shell, without changing the original Thread/branch. */
export function useOpenThreadContext() {
  const bot = useWorkbenchProfileId() === VARIN_WORKBENCH_BOT_PROFILE_ID;
  return React.useCallback((identity: ThreadIdentity, directory?: string, jobRunId?: string, readOnly = false) => {
    // This key selects presentation only, never a Source or read grant.
    const root = bot ? BOT_CONVERSATION_PANEL_SCOPE : useDirectoryStore.getState().currentDirectory || directory || '';
    useUIStore.getState().openContextPanelTab(root, { mode: 'context', dedupeKey: 'context', thread: identity, targetPath: jobRunId ?? null, readOnly });
  }, [bot]);
}
