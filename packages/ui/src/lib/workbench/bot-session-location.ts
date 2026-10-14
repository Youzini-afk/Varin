import type { ThreadIdentity } from '@varin/application-client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';

interface OrdinaryLocation { hostKey: string; identity: ThreadIdentity | null; directory: string; projectId: string | null; }
let ordinaryLocation: OrdinaryLocation | null = null;
export const rememberOrdinarySession = (): void => {
  const state = useThreadStore.getState();
  const selected = state.threads.find(thread => thread.thread_id === state.selectedIdentity?.threadId);
  ordinaryLocation = { hostKey: state.hostKey, identity: selected?.bot_id ? null : state.selectedIdentity,
    directory: useDirectoryStore.getState().currentDirectory, projectId: useProjectsStore.getState().activeProjectId };
};
export const restoreOrdinarySession = (): void => {
  const state = useThreadStore.getState();
  const saved = ordinaryLocation?.hostKey === state.hostKey ? ordinaryLocation : null;
  useProjectsStore.getState().setActiveProjectIdOnly(saved?.projectId ?? null);
  const directory = useDirectoryStore.getState();
  const target = saved?.directory || directory.homeDirectory;
  if (target && target !== directory.currentDirectory) directory.setDirectory(target, { showOverlay: false });
  useThreadStore.setState({ selectedIdentity: null });
  if (saved?.identity) void state.selectThread(saved.identity).catch(error => console.error('[Workbench] Conversation restore unavailable:', error));
  useUIStore.getState().setActiveMainTab('chat');
};
