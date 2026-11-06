import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RuntimeAPIs, RuntimeEndpointChangedDetail, WorkspaceRootInfo } from '@varin/application-client';

const runtime = vi.hoisted(() => ({
  key: 'host-a',
  desktopLocal: false,
  listeners: new Set<(detail: RuntimeEndpointChangedDetail) => void>(),
  desktopHome: vi.fn<() => Promise<string | null>>(),
  save: vi.fn<(changes: object) => Promise<boolean>>(async () => true),
}));

vi.mock('@varin/application-client', async (original) => ({
  ...await original<typeof import('@varin/application-client')>(),
  getRuntimeKey: () => runtime.key,
  getRuntimeApiBaseUrl: () => `https://${runtime.key}.example`,
  subscribeRuntimeEndpointChanged: (listener: (detail: RuntimeEndpointChangedDetail) => void) => {
    runtime.listeners.add(listener);
    return () => runtime.listeners.delete(listener);
  },
}));
vi.mock('@/lib/desktop', () => ({
  isDesktopLocalOriginActive: () => runtime.desktopLocal,
  getDesktopHomeDirectory: runtime.desktopHome,
}));
vi.mock('@/lib/persistence', () => ({ updateDesktopSettings: runtime.save }));
vi.mock('@/stores/useFileSearchStore', () => ({
  useFileSearchStore: { getState: () => ({ invalidateDirectory: () => {} }) },
}));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const workspaceAPI = (root: string | Promise<string>) => {
  const getRoot = vi.fn(async () => ({ root: await root } as WorkspaceRootInfo));
  return { apis: { workspace: { getRoot } } as unknown as RuntimeAPIs, getRoot };
};

const loadStores = async () => {
  const { applyPersistedDirectoryPreferences, subscribeDefaultDirectoryToRuntimeChanges } = await import('./directoryPersistence');
  const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
  const { useProjectsStore } = await import('@/stores/useProjectsStore');
  const { getDeferredSafeStorage } = await import('@/stores/utils/safeStorage');
  return {
    restore: applyPersistedDirectoryPreferences,
    subscribe: subscribeDefaultDirectoryToRuntimeChanges,
    directory: useDirectoryStore,
    projects: useProjectsStore,
    storage: getDeferredSafeStorage(),
  };
};

const switchHost = (key: string, desktopLocal = false) => {
  const previousRuntimeKey = runtime.key;
  runtime.key = key;
  runtime.desktopLocal = desktopLocal;
  for (const listener of runtime.listeners) {
    listener({
      runtimeKey: key,
      previousRuntimeKey,
      apiBaseUrl: `https://${key}.example`,
      previousApiBaseUrl: `https://${previousRuntimeKey}.example`,
    });
  }
};

beforeEach(() => {
  vi.resetModules();
  runtime.key = 'host-a';
  runtime.desktopLocal = false;
  runtime.listeners.clear();
  runtime.save.mockClear();
  runtime.desktopHome.mockReset().mockImplementation(async () => window.__VARIN_HOME__ ?? null);
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
  const events = new EventTarget();
  vi.stubGlobal('window', {
    localStorage: storage,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    setTimeout,
    clearTimeout,
  });
  vi.stubGlobal('localStorage', storage);
  // The Node runner has a HOME; make its fallback match a clean browser's '/'.
  vi.stubEnv('HOME', '/');
});

afterEach(async () => {
  const { resetSafeStorageForTests } = await import('@/stores/utils/safeStorage');
  resetSafeStorageForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('authenticated directory restoration', () => {
  const root = '/home/varin/workspaces/default';

  test.each([undefined, '/', '/home/varin'])('uses the Host root with no selected project and cached home %s', async (home) => {
    if (home) {
      localStorage.setItem('homeDirectory', home);
      localStorage.setItem('lastDirectory', '/');
    }
    const { restore, directory, storage } = await loadStores();
    if (!home) expect(directory.getState().currentDirectory).toBe('/');
    await restore(workspaceAPI(root).apis);

    expect(directory.getState()).toMatchObject({ homeDirectory: root, currentDirectory: root, isHomeReady: true });
    expect(storage.getItem('homeDirectory')).toBe(root);
    directory.getState().setDirectory(`${root}/other`);
    await directory.getState().goHome();
    expect(directory.getState().currentDirectory).toBe(root);
    expect(runtime.desktopHome).not.toHaveBeenCalled();
    expect(runtime.save.mock.calls.every(([changes]) => !('homeDirectory' in changes))).toBe(true);
  });

  test('keeps an existing project directory, then returns to the Host root when deselected', async () => {
    const project = { id: 'project-a', path: `${root}/project-a` };
    localStorage.setItem('lastDirectory', `${project.path}/src`);
    const { restore, directory, projects } = await loadStores();
    projects.setState({ projects: [project], activeProjectId: project.id });
    await restore(workspaceAPI(root).apis);
    expect(directory.getState().currentDirectory).toBe(`${project.path}/src`);
    expect(directory.getState().homeDirectory).toBe(root);

    expect(await projects.getState().setActiveProject(null)).toBe(true);
    expect(directory.getState().currentDirectory).toBe(root);
  });

  test('does not overwrite a project selected while the Host root is loading', async () => {
    const pending = deferred<string>();
    const { restore, directory, projects } = await loadStores();
    const restoring = restore(workspaceAPI(pending.promise).apis);
    const project = { id: 'new-project', path: `${root}/new-project` };
    projects.setState({ projects: [project] });
    expect(await projects.getState().setActiveProject(project.id)).toBe(true);
    pending.resolve(root);
    await restoring;
    expect(directory.getState()).toMatchObject({ homeDirectory: root, currentDirectory: project.path });
  });

  test('keeps local desktop home without reading the server workspace root', async () => {
    runtime.desktopLocal = true;
    window.__VARIN_HOME__ = 'C:/Users/example';
    localStorage.setItem('lastDirectory', 'D:/projects/previous');
    const { restore, directory } = await loadStores();
    const { apis, getRoot } = workspaceAPI('D:/projects');
    await restore(apis);
    expect(getRoot).not.toHaveBeenCalled();
    expect(directory.getState()).toMatchObject({ homeDirectory: 'C:/Users/example', currentDirectory: 'C:/Users/example' });
  });

  test('uses remote home in a desktop shell and restores preload home when switching back to local', async () => {
    window.__VARIN_HOME__ = 'C:/Users/example';
    const { restore, directory } = await loadStores();
    await restore(workspaceAPI(root).apis);
    expect(directory.getState().homeDirectory).toBe(root);
    expect(runtime.desktopHome).not.toHaveBeenCalled();

    switchHost('local', true);
    await restore(workspaceAPI(root).apis);
    expect(directory.getState()).toMatchObject({ homeDirectory: 'C:/Users/example', currentDirectory: 'C:/Users/example' });
  });

  test('ignores a departing Host root and retains home across same-Host transport changes', async () => {
    const pending = deferred<string>();
    const { restore, directory, storage, subscribe } = await loadStores();
    const departing = restore(workspaceAPI(pending.promise).apis);
    switchHost('host-b');
    const current = workspaceAPI('/srv/host-b');
    await restore(current.apis);
    pending.resolve(root);
    await departing;
    expect(directory.getState()).toMatchObject({ homeDirectory: '/srv/host-b', currentDirectory: '/srv/host-b' });
    expect(storage.getItem('homeDirectory')).toBe('/srv/host-b');

    const unsubscribe = subscribe(current.apis);
    directory.getState().setDirectory('/srv/host-b/project');
    switchHost('host-b');
    await Promise.resolve();
    expect(current.getRoot).toHaveBeenCalledTimes(1);
    expect(directory.getState().currentDirectory).toBe('/srv/host-b/project');
    await directory.getState().goHome();
    expect(directory.getState().currentDirectory).toBe('/srv/host-b');
    unsubscribe();
  });

  test('restores the new Host home after its settings synchronization', async () => {
    const { restore, directory, storage, subscribe } = await loadStores();
    await restore(workspaceAPI(root).apis);
    const next = workspaceAPI('/srv/host-b');
    const unsubscribe = subscribe(next.apis);
    switchHost('host-b');
    await Promise.resolve();
    expect(next.getRoot).not.toHaveBeenCalled();

    storage.removeItem('homeDirectory');
    storage.removeItem('lastDirectory');
    window.dispatchEvent(new Event('varin:settings-synced'));
    await vi.waitFor(() => {
      expect(directory.getState()).toMatchObject({ homeDirectory: '/srv/host-b', currentDirectory: '/srv/host-b' });
    });
    expect(storage.getItem('homeDirectory')).toBe('/srv/host-b');
    unsubscribe();
  });

  test('does not let late local home initialization overwrite the remote home cache', async () => {
    const localHome = deferred<string>();
    runtime.desktopLocal = true;
    runtime.desktopHome.mockReturnValue(localHome.promise);
    const { restore, directory, storage } = await loadStores();
    switchHost('host-b');
    await restore(workspaceAPI(root).apis);
    localHome.resolve('C:/Users/example');
    await localHome.promise;
    await Promise.resolve();
    await directory.getState().goHome();
    expect(directory.getState()).toMatchObject({ homeDirectory: root, currentDirectory: root });
    expect(storage.getItem('homeDirectory')).toBe(root);
  });

  test('does not invent a new home when the Host root is unavailable', async () => {
    const { restore, directory } = await loadStores();
    await restore(workspaceAPI(root).apis);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failed = { workspace: { getRoot: async () => { throw new Error('offline'); } } } as unknown as RuntimeAPIs;
    await restore(failed);
    expect(warning).toHaveBeenCalled();
    expect(directory.getState()).toMatchObject({ homeDirectory: root, currentDirectory: root });
  });
});
