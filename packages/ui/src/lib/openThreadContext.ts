import type { ThreadIdentity } from '@varin/application-client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';

export function openThreadContext(identity: ThreadIdentity, directory?: string, jobRunId?: string, readOnly = false) {
  // This key selects the visible sidebar, not a Source or read grant. The exact
  // Thread/branch below remains the context owner even in another workspace view.
  const root = useDirectoryStore.getState().currentDirectory || directory || '';
  useUIStore.getState().openContextPanelTab(root, { mode: 'context', dedupeKey: 'context', thread: identity, targetPath: jobRunId ?? null, readOnly });
}
