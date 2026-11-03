import type { ThreadIdentity } from '@varin/application-client';
import { useUIStore } from '@/stores/useUIStore';

export function openThreadContext(identity: ThreadIdentity, directory?: string, jobRunId?: string, readOnly = false) {
  const root = directory ?? '';
  useUIStore.getState().openContextPanelTab(root, { mode: 'context', dedupeKey: 'context', thread: identity, targetPath: jobRunId ?? null, readOnly });
}
