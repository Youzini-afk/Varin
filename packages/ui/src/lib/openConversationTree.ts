import type { ThreadIdentity } from '@varin/application-client';
import { useUIStore } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
export function openConversationTree(identity: ThreadIdentity): void {
  const root = useDirectoryStore.getState().currentDirectory || '';
  useUIStore.getState().openContextPanelTab(root, { mode: 'tree', thread: identity, dedupeKey: 'tree' });
}
