import { openPiSessionFromNavigation } from '@/lib/pi-runtime/sessionNavigation';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useBotSessionIndex } from '@/stores/useBotSessionIndex';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';

interface OrdinarySessionLocation {
  runtimeKey: string;
  sessionId: string | null;
  directory: string;
  projectId: string | null;
}

let ordinarySessionLocation: OrdinarySessionLocation | null = null;

export const rememberOrdinarySession = (): void => {
  const sessions = usePiSessionStore.getState();
  const sessionId = sessions.currentSessionId;
  const index = useBotSessionIndex.getState();
  ordinarySessionLocation = {
    runtimeKey: sessions.runtimeKey,
    sessionId: sessionId && index.runtimeKey === sessions.runtimeKey && index.ids?.has(sessionId)
      ? null : sessionId,
    directory: useDirectoryStore.getState().currentDirectory,
    projectId: useProjectsStore.getState().activeProjectId,
  };
};

export const restoreOrdinarySession = (): void => {
  const sessions = usePiSessionStore.getState();
  const saved = ordinarySessionLocation?.runtimeKey === sessions.runtimeKey ? ordinarySessionLocation : null;
  const projects = useProjectsStore.getState();
  projects.setActiveProjectIdOnly(saved?.projectId ?? null);
  const directory = useDirectoryStore.getState();
  const targetDirectory = saved?.directory || directory.homeDirectory;
  if (targetDirectory && targetDirectory !== directory.currentDirectory) {
    directory.setDirectory(targetDirectory, { showOverlay: false });
  }
  const sessionId = saved?.sessionId ?? null;
  if (sessionId && sessions.records[sessionId]?.open) {
    sessions.setCurrentSession(sessionId);
  } else {
    sessions.setCurrentSession(null);
    if (sessionId) {
      void openPiSessionFromNavigation({ sessionId, directory: saved?.directory }).catch((error: unknown) => {
        console.error('[Workbench] Failed to restore ordinary session:', error);
      });
    }
  }
  useUIStore.getState().setActiveMainTab('chat');
};
