import type { ThreadIdentity } from '@varin/application-client';
import { toast } from '@/components/ui';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { useUIStore } from '@/stores/useUIStore';
import { openThreadFromNavigation } from './agent-runtime/threadNavigation';

export function openCollaborationMember(source: ThreadIdentity, member: ThreadIdentity): void {
  const current = useThreadStore.getState().selectedIdentity;
  if (current?.threadId !== source.threadId || current.branchId !== source.branchId) {
    // A secondary history view can link to a child of a different route.
    void openThreadFromNavigation(member).catch(error => toast.error(String(error)));
    return;
  }
  const directory = useDirectoryStore.getState().currentDirectory;
  useUIStore.getState().openContextPanelTab(directory, { mode: 'threads', thread: source, member });
}
