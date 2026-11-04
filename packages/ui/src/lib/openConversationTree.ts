import { useUIStore } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

// The Bot shell has a panel layout of its own and no navigation directory.
export const BOT_TREE_PANEL_SCOPE = 'varin:bot:conversation-tree';

export function openConversationTree(surface: 'workbench' | 'bot' = 'workbench'): void {
  const scope = surface === 'bot' ? BOT_TREE_PANEL_SCOPE : useDirectoryStore.getState().currentDirectory;
  useUIStore.getState().openContextPanelTab(scope, { mode: 'tree' });
}
