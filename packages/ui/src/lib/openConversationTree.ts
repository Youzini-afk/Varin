import { useUIStore } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

// The Bot shell shares one conversation panel for context and history, independent
// of navigation directories. Retain its persisted layout key.
export const BOT_CONVERSATION_PANEL_SCOPE = 'varin:bot:conversation-tree';

export function openConversationTree(surface: 'workbench' | 'bot' = 'workbench'): void {
  const scope = surface === 'bot' ? BOT_CONVERSATION_PANEL_SCOPE : useDirectoryStore.getState().currentDirectory;
  useUIStore.getState().openContextPanelTab(scope, { mode: 'tree' });
}
