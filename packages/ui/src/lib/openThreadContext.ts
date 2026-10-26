import type { ThreadIdentity } from '@varin/application-client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';

export function openThreadContext(identity: ThreadIdentity, directory?: string, jobRunId?: string, readOnly = false) {
  const root = useDirectoryStore.getState().currentDirectory || directory || '';
  useUIStore.getState().openContextPanelTab(root, { mode: 'context', dedupeKey: 'context', thread: identity, targetPath: jobRunId ?? null, readOnly });
}
