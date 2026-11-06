import type { RuntimeAPIs } from '@varin/application-client';
import { isDesktopLocalOriginActive } from '@/lib/desktop';
import {
  resolveRuntimeWorkspaceRoot,
  resolveWorkspaceAwareRestoredDirectory,
} from '@/lib/defaultDirectory';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';

const safeStorage = getDeferredSafeStorage();

const readSavedDirectory = (): string | null => {
  const value = safeStorage.getItem('lastDirectory');
  return typeof value === 'string' && value.trim() ? value : null;
};

export const applyPersistedDirectoryPreferences = async (
  apis?: RuntimeAPIs,
  options: { ignorePersistedDirectory?: string | null } = {},
): Promise<void> => {
  if (typeof window === 'undefined') {
    return;
  }

  const runtimeKey = getRuntimeKey();
  const observedDirectory = readSavedDirectory();
  const ignoredDirectory = options.ignorePersistedDirectory?.trim() || null;
  const savedDirectory = observedDirectory === ignoredDirectory ? null : observedDirectory;

  let workspaceRoot: string | null = null;
  if (apis) {
    try {
      workspaceRoot = await resolveRuntimeWorkspaceRoot(apis, {
        desktopLocal: isDesktopLocalOriginActive(),
      });
    } catch (error) {
      console.warn('Failed to resolve the runtime workspace root:', error);
    }
  }

  if (getRuntimeKey() !== runtimeKey) return;

  // Web/mobile and remote desktop navigation belong to the authenticated Host.
  // Its workspace root is accessible even when the OS home (or a previous
  // Host's cached home) is outside the allowed boundary. Update home as well as
  // the initial directory so Go Home and leaving a project keep that authority.
  // Local desktop keeps its preload-provided home instead.
  if (workspaceRoot) {
    useDirectoryStore.getState().synchronizeHomeDirectory(workspaceRoot);
  }

  const directoryState = useDirectoryStore.getState();
  const hasSelectedWorkspace = useProjectsStore.getState().activeProjectId !== null;
  const nextDirectory = resolveWorkspaceAwareRestoredDirectory({
    hasSelectedWorkspace,
    homeDirectory: directoryState.homeDirectory,
    latestPersistedDirectory: readSavedDirectory(),
    persistedDirectory: savedDirectory,
    workspaceRoot,
  });
  if (nextDirectory && nextDirectory !== directoryState.currentDirectory) {
    directoryState.setDirectory(nextDirectory, { showOverlay: false });
  }
};

export const waitForRuntimeSettingsSync = (
  windowObject: Pick<Window, 'addEventListener' | 'clearTimeout' | 'removeEventListener' | 'setTimeout'>,
  timeoutMs = 10_000,
): Promise<boolean> => new Promise((resolve) => {
  let settled = false;
  const finish = (synced: boolean) => {
    if (settled) return;
    settled = true;
    windowObject.clearTimeout(timeout);
    windowObject.removeEventListener('varin:settings-synced', handleSettingsSynced);
    resolve(synced);
  };
  const handleSettingsSynced = () => finish(true);
  windowObject.addEventListener('varin:settings-synced', handleSettingsSynced, { once: true });
  const timeout = windowObject.setTimeout(() => finish(false), timeoutMs);
});

export const subscribeDefaultDirectoryToRuntimeChanges = (apis: RuntimeAPIs): (() => void) => (
  subscribeRuntimeEndpointChanged((detail) => {
    // LAN/relay transport swaps for the same runtime keep the same filesystem
    // authority, so they must not reset the user's active project directory.
    if (detail.runtimeKey === detail.previousRuntimeKey) return;
    const previousPersistedDirectory = readSavedDirectory();
    queueMicrotask(() => void (async () => {
      const settingsSynced = await waitForRuntimeSettingsSync(window);
      if (getRuntimeKey() !== detail.runtimeKey) return;
      await applyPersistedDirectoryPreferences(apis, {
        ignorePersistedDirectory: settingsSynced ? null : previousPersistedDirectory,
      });
    })());
  })
);
