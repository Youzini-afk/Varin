import { afterAll, beforeEach, describe, expect, test } from 'vitest';

import type { RuntimeAPIs, SettingsPayload } from '@varin/application-client';
import type { DesktopSettings } from '@/lib/desktop';
import { registerRuntimeAPIs } from '@/lib/runtime-api/registry';
import { startModelPrefsAutoSave } from '@/lib/modelPrefsAutoSave';
import { startAppearanceAutoSave } from '@/lib/appearanceAutoSave';
import { useUIStore } from '@/stores/useUIStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import {
  applyPersistedHomeDirectoryToWindow,
  getSettingsSaveState,
  invalidateSettingsCache,
  subscribeToSettingsSaveState,
  syncDesktopSettings,
  updateDesktopSettings,
} from './persistence';
import { switchRuntimeEndpoint } from '@varin/application-client';

type TestWindow = {
  __VARIN_HOME__?: string;
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  dispatchEvent: (event: Event) => boolean;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
};

let createdWindow = false;
let createdLocalStorage = false;

const ensureLocalStorage = (): void => {
  if (typeof localStorage !== 'undefined') {
    return;
  }

  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
      clear: () => {
        values.clear();
      },
    },
    configurable: true,
    writable: true,
  });
  createdLocalStorage = true;
};

const getWindow = (): TestWindow => {
  if (typeof window === 'undefined') {
    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
      writable: true,
    });
    createdWindow = true;
  }
  const testWindow = window as unknown as Partial<TestWindow>;
  if (!testWindow.addEventListener || !testWindow.removeEventListener) {
    const eventTarget = new EventTarget();
    testWindow.addEventListener = eventTarget.addEventListener.bind(eventTarget);
    testWindow.removeEventListener = eventTarget.removeEventListener.bind(eventTarget);
    testWindow.dispatchEvent = eventTarget.dispatchEvent.bind(eventTarget);
  }
  testWindow.dispatchEvent ??= () => true;
  testWindow.setTimeout ??= setTimeout;
  testWindow.clearTimeout ??= clearTimeout;
  ensureLocalStorage();
  return testWindow as TestWindow;
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const registerSettingsApi = (
  save: (changes: Partial<SettingsPayload>) => Promise<SettingsPayload>,
  load: () => Promise<{ settings: SettingsPayload; source: 'web' }> = async () => ({ settings: {}, source: 'web' }),
): void => {
  registerRuntimeAPIs({
    runtime: { platform: 'web', isDesktop: false },
    settings: {
      load,
      save,
    },
  } as unknown as RuntimeAPIs);
};

const registerSettingsSave = (save: (changes: Partial<SettingsPayload>) => Promise<SettingsPayload>): void => {
  registerSettingsApi(save);
};

const resetModelPrefsState = (): void => {
  useUIStore.setState({
    favoriteModels: [],
    hiddenModels: [],
    collapsedModelProviders: [],
    recentModels: [],
    recentAgents: [],
    recentEfforts: {},
  });
};

afterAll(() => {
  registerRuntimeAPIs(null);
  if (createdWindow) {
    delete (globalThis as { window?: unknown }).window;
  } else if (typeof window !== 'undefined') {
    delete getWindow().__VARIN_HOME__;
  }
  if (createdLocalStorage) {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

describe('applyPersistedHomeDirectoryToWindow', () => {
  beforeEach(() => {
    delete getWindow().__VARIN_HOME__;
  });

  test('does not overwrite an injected desktop home directory', () => {
    getWindow().__VARIN_HOME__ = '/Users/example';

    applyPersistedHomeDirectoryToWindow('/Users/example/projects/app');

    expect(getWindow().__VARIN_HOME__).toBe('/Users/example');
  });

  test('uses persisted home when no runtime home was injected', () => {
    applyPersistedHomeDirectoryToWindow('/Users/example/projects/app');

    expect(getWindow().__VARIN_HOME__).toBe('/Users/example/projects/app');
  });
});

describe('updateDesktopSettings', () => {
  beforeEach(() => {
    getWindow();
    registerRuntimeAPIs(null);
    invalidateSettingsCache();
    resetModelPrefsState();
  });

  test('waits for the debounced settings save to finish before resolving', async () => {
    let saveStarted = false;
    let saveFinished = false;
    let updateResolved = false;

    registerSettingsSave(async () => {
      saveStarted = true;
      await delay(100);
      saveFinished = true;
      return {};
    });

    const update = updateDesktopSettings({
      skillCatalogs: [{ id: 'custom:test', label: 'Test', source: 'owner/repo' }],
    });
    update.then(() => {
      updateResolved = true;
    }).catch(() => {
      updateResolved = true;
    });

    await delay(50);
    expect(saveStarted).toBe(false);
    expect(updateResolved).toBe(false);

    await delay(200);
    expect(saveStarted).toBe(true);
    expect(saveFinished).toBe(false);
    expect(updateResolved).toBe(false);

    await update;
    expect(saveFinished).toBe(true);
    expect(updateResolved).toBe(true);
  });

  test('coalesces rapid settings updates and resolves every caller after one merged save', async () => {
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    let firstResolved = false;
    let secondResolved = false;

    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      await delay(50);
      return {};
    });

    const first = updateDesktopSettings({ themeVariant: 'dark' });
    first.then(() => {
      firstResolved = true;
    }).catch(() => {
      firstResolved = true;
    });

    await delay(50);

    const second = updateDesktopSettings({ fontSize: 14 });
    second.then(() => {
      secondResolved = true;
    }).catch(() => {
      secondResolved = true;
    });

    await Promise.all([first, second]);

    expect(saveCalls).toEqual([{ themeVariant: 'dark', fontSize: 14 }]);
    expect(firstResolved).toBe(true);
    expect(secondResolved).toBe(true);
  });

  test('retains project work focus and model defaults through save and reload', async () => {
    let persisted: SettingsPayload = {};
    registerSettingsApi(
      async (changes) => { persisted = { ...persisted, ...changes }; return persisted; },
      async () => ({ settings: persisted, source: 'web' }),
    );
    const project = {
      id: 'research-project', path: 'D:/research', label: 'Research',
      defaultWorkFocus: 'research' as const, defaultModel: 'provider/model',
    };
    expect(await updateDesktopSettings({ projects: [project] })).toBe(true);
    useProjectsStore.setState({ projects: [] });
    invalidateSettingsCache();
    const applyProjects = (event: Event) => {
      useProjectsStore.getState().synchronizeFromSettings((event as CustomEvent<DesktopSettings>).detail);
    };
    getWindow().addEventListener('varin:settings-synced', applyProjects);
    try {
      await syncDesktopSettings();
    } finally {
      getWindow().removeEventListener('varin:settings-synced', applyProjects);
    }

    const restored = useProjectsStore.getState().projects.find((entry) => entry.path === project.path);
    expect(restored?.defaultWorkFocus).toBe('research');
    expect(restored?.defaultModel).toBe('provider/model');
  });

  test('publishes saving and saved states for an immediate setting update', async () => {
    const states: string[] = [];
    registerSettingsSave(async (changes) => changes as SettingsPayload);
    const unsubscribe = subscribeToSettingsSaveState(() => {
      states.push(getSettingsSaveState());
    });

    try {
      const persisted = await updateDesktopSettings({ useSystemTheme: false, themeVariant: 'light' });
      // Success is silent: the shared state machine maps 'saved' back to 'idle'.
      expect(persisted).toBe(true);
      expect(states).toEqual(['saving', 'idle']);
    } finally {
      unsubscribe();
    }
  });

  test('activates a project directory only after its Host settings grant is persisted', async () => {
    const originalDirectory = useDirectoryStore.getState();
    const originalProjects = useProjectsStore.getState();
    const saveResult = deferred<SettingsPayload>();
    const saveStarted = deferred<void>();
    const project = { id: 'project-granted', path: 'D:/projects/granted', label: 'Granted' };
    registerSettingsSave(async () => {
      saveStarted.resolve();
      return saveResult.promise;
    });

    try {
      useDirectoryStore.setState({ currentDirectory: 'D:/projects/previous' });
      useProjectsStore.setState({
        activeProjectId: null,
        manualProjectOrder: [],
        projects: [project],
      });

      const activation = useProjectsStore.getState().setActiveProject(project.id);
      await saveStarted.promise;
      expect(useProjectsStore.getState().activeProjectId).toBeNull();
      expect(useDirectoryStore.getState().currentDirectory).toBe('D:/projects/previous');

      saveResult.resolve({ activeProjectId: project.id, projects: [project] });
      expect(await activation).toBe(true);
      expect(useProjectsStore.getState().activeProjectId).toBe(project.id);
      expect(useDirectoryStore.getState().currentDirectory).toBe(project.path);
    } finally {
      useDirectoryStore.setState(originalDirectory, true);
      useProjectsStore.setState(originalProjects, true);
    }
  });

  test('preserves the previous project and directory when the Host grant fails', async () => {
    const originalDirectory = useDirectoryStore.getState();
    const originalProjects = useProjectsStore.getState();
    const previousFetch = globalThis.fetch;
    const previous = { id: 'project-previous', path: 'D:/projects/previous', label: 'Previous' };
    const target = { id: 'project-denied', path: 'D:/projects/denied', label: 'Denied' };
    registerSettingsSave(async () => {
      throw new Error('settings unavailable');
    });
    globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;

    try {
      useDirectoryStore.setState({ currentDirectory: previous.path });
      useProjectsStore.setState({
        activeProjectId: previous.id,
        manualProjectOrder: [],
        projects: [previous, target],
      });

      expect(await useProjectsStore.getState().setActiveProject(target.id)).toBe(false);
      expect(useProjectsStore.getState().activeProjectId).toBe(previous.id);
      expect(useDirectoryStore.getState().currentDirectory).toBe(previous.path);
    } finally {
      globalThis.fetch = previousFetch;
      useDirectoryStore.setState(originalDirectory, true);
      useProjectsStore.setState(originalProjects, true);
    }
  });

  test('drains a pending save to the previous runtime and ignores its stale response', async () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://settings-a.example', runtimeKey: 'settings-a' });
    const saveResult = deferred<SettingsPayload>();
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave((changes) => {
      saveCalls.push(changes);
      return saveResult.promise;
    });
    const update = updateDesktopSettings({ terminalShell: 'zsh' });

    switchRuntimeEndpoint({ apiBaseUrl: 'https://settings-b.example', runtimeKey: 'settings-b' });
    registerSettingsSave(async (changes) => changes as SettingsPayload);
    useUIStore.getState().setTerminalShell('fish');

    expect(saveCalls).toEqual([{ terminalShell: 'zsh' }]);
    saveResult.resolve({ terminalShell: 'zsh' });
    await update;

    expect(useUIStore.getState().terminalShell).toBe('fish');
  });

  test('ignores an older save response after a newer save completes on the same runtime', async () => {
    const firstSave = deferred<SettingsPayload>();
    const firstSaveStarted = deferred<void>();
    let saveCount = 0;
    registerSettingsSave(async (changes) => {
      saveCount += 1;
      if (saveCount === 1) {
        firstSaveStarted.resolve();
        return firstSave.promise;
      }
      return changes as SettingsPayload;
    });

    const firstUpdate = updateDesktopSettings({ terminalShell: 'zsh' });
    await firstSaveStarted.promise;
    const secondUpdate = updateDesktopSettings({ terminalShell: 'fish' });
    expect(await secondUpdate).toBe(true);
    expect(useUIStore.getState().terminalShell).toBe('fish');

    firstSave.resolve({ terminalShell: 'zsh' });
    expect(await firstUpdate).toBe(true);
    expect(useUIStore.getState().terminalShell).toBe('fish');
  });

  test('does not retry a failed old-runtime save against the new runtime', async () => {
    const previousFetch = globalThis.fetch;
    const fallbackRequests: string[] = [];
    const saveResult = deferred<SettingsPayload>();
    try {
      globalThis.fetch = (async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (init?.method === 'PUT' && url.includes('/api/config/settings')) fallbackRequests.push(url);
        return new Response(null, { status: 404 });
      }) as typeof fetch;
      switchRuntimeEndpoint({ apiBaseUrl: 'https://failed-save-a.example', runtimeKey: 'failed-save-a' });
      registerSettingsSave(() => saveResult.promise);
      const update = updateDesktopSettings({ terminalShell: 'zsh' });

      switchRuntimeEndpoint({ apiBaseUrl: 'https://failed-save-b.example', runtimeKey: 'failed-save-b' });
      registerSettingsSave(async (changes) => changes as SettingsPayload);
      saveResult.reject(new Error('runtime A disconnected'));
      await update;

      expect(fallbackRequests).toEqual([]);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test('rejects stale loads by generation across an A to B to A switch', async () => {
    const originalLoad = deferred<{ settings: SettingsPayload; source: 'web' }>();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://load-a.example', runtimeKey: 'load-a' });
    registerSettingsApi(async () => ({}), () => originalLoad.promise);
    const firstSync = syncDesktopSettings();

    switchRuntimeEndpoint({ apiBaseUrl: 'https://load-b.example', runtimeKey: 'load-b' });
    registerSettingsApi(async () => ({}), async () => ({
      settings: { terminalShell: 'fish' },
      source: 'web',
    }));
    await syncDesktopSettings();
    expect(useUIStore.getState().terminalShell).toBe('fish');

    switchRuntimeEndpoint({ apiBaseUrl: 'https://load-a.example', runtimeKey: 'load-a' });
    registerSettingsApi(async () => ({}), async () => ({
      settings: { terminalShell: 'bash' },
      source: 'web',
    }));
    await syncDesktopSettings();
    expect(useUIStore.getState().terminalShell).toBe('bash');

    originalLoad.resolve({
      settings: { terminalShell: 'zsh' },
      source: 'web',
    });
    await firstSync;
    expect(useUIStore.getState().terminalShell).toBe('bash');
  });

  test('does not let an invalidated in-flight settings load overwrite the refreshed cache', async () => {
    const staleLoad = deferred<{ settings: SettingsPayload; source: 'web' }>();
    registerSettingsApi(async () => ({}), () => staleLoad.promise);
    const firstSync = syncDesktopSettings();

    invalidateSettingsCache();
    registerSettingsApi(async () => ({}), async () => ({
      settings: { terminalShell: 'fish' },
      source: 'web',
    }));
    await syncDesktopSettings();
    expect(useUIStore.getState().terminalShell).toBe('fish');

    staleLoad.resolve({ settings: { terminalShell: 'zsh' }, source: 'web' });
    await firstSync;
    expect(useUIStore.getState().terminalShell).toBe('fish');

    await syncDesktopSettings();
    expect(useUIStore.getState().terminalShell).toBe('fish');
  });

  test('removes browser projections omitted by the next authoritative runtime', async () => {
    getWindow();
    localStorage.clear();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://mirror-a.example', runtimeKey: 'mirror-a' });
    registerSettingsApi(async () => ({}), async () => ({
      settings: {
        directoryShowHidden: true,
        sttModel: 'model-a',
      },
      source: 'web',
    }));
    await syncDesktopSettings();

    switchRuntimeEndpoint({ apiBaseUrl: 'https://mirror-b.example', runtimeKey: 'mirror-b' });
    registerSettingsApi(async () => ({}), async () => ({
      settings: {},
      source: 'web',
    }));
    await syncDesktopSettings();

    expect(localStorage.getItem('directoryTreeShowHidden')).toBeNull();
    expect(localStorage.getItem('sttModel')).toBeNull();
  });

  test('resets in-memory preferences omitted by an authoritative runtime snapshot', async () => {
    getWindow();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://preferences-a.example', runtimeKey: 'preferences-a' });
    registerSettingsApi(async () => ({}), async () => ({
      settings: {
        showReasoningTraces: false,
        terminalShell: 'fish',
        favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-sonnet-4' }],
        followUpBehavior: 'steer',
        recoveryPreference: 'both',
        draftStarters: [{ type: 'command', name: 'runtime-a' }],
        draftStartersVisible: false,
      },
      source: 'web',
    }));
    await syncDesktopSettings();

    expect(useUIStore.getState().showReasoningTraces).toBe(false);
    expect(useUIStore.getState().terminalShell).toBe('fish');
    expect(useUIStore.getState().favoriteModels).toHaveLength(1);
    expect(useUIStore.getState().globalDraftStarters).toEqual([{ type: 'command', name: 'runtime-a' }]);
    expect(useUIStore.getState().draftStartersVisible).toBe(false);
    expect(useMessageQueueStore.getState().followUpBehavior).toBe('steer');
    expect(useUIStore.getState().recoveryPreference).toBe('both');

    switchRuntimeEndpoint({ apiBaseUrl: 'https://preferences-b.example', runtimeKey: 'preferences-b' });
    registerSettingsApi(async () => ({}), async () => ({
      settings: {},
      source: 'web',
    }));
    await syncDesktopSettings();

    expect(useUIStore.getState().showReasoningTraces).toBe(true);
    expect(useUIStore.getState().terminalShell).toBe('auto');
    expect(useUIStore.getState().favoriteModels).toEqual([]);
    expect(useUIStore.getState().globalDraftStarters).toBeNull();
    expect(useUIStore.getState().draftStartersVisible).toBe(true);
    expect(useMessageQueueStore.getState().followUpBehavior).toBe('queue');
    expect(useUIStore.getState().recoveryPreference).toBe('conversation');
  });

  test('treats settings save responses as partial patches', async () => {
    getWindow();
    useUIStore.getState().setTerminalShell('fish');
    registerSettingsSave(async () => ({ showReasoningTraces: false }));

    await updateDesktopSettings({ showReasoningTraces: false });

    expect(useUIStore.getState().showReasoningTraces).toBe(false);
    expect(useUIStore.getState().terminalShell).toBe('fish');
  });

  test('applies model selector settings from server settings', async () => {
    getWindow();
    const settings = {
      favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-haiku-4' }],
      hiddenModels: [{ providerID: 'openai', modelID: 'gpt-5' }],
      collapsedModelProviders: ['anthropic', 'openai'],
      recentModels: [{ providerID: 'google', modelID: 'gemini-pro' }],
      recentAgents: ['build', 'plan'],
      recentEfforts: { 'anthropic/claude-haiku-4': ['high', 'default'] },
    } satisfies SettingsPayload;
    registerSettingsApi(async () => ({}), async () => ({ settings, source: 'web' }));

    await syncDesktopSettings();

    const state = useUIStore.getState();
    expect(state.favoriteModels).toEqual(settings.favoriteModels);
    expect(state.hiddenModels).toEqual(settings.hiddenModels);
    expect(state.collapsedModelProviders).toEqual(settings.collapsedModelProviders);
    expect(state.recentModels).toEqual(settings.recentModels);
    expect(state.recentAgents).toEqual(settings.recentAgents);
    expect(state.recentEfforts).toEqual(settings.recentEfforts);
  });

  test('applies the persisted terminal shell from server settings', async () => {
    getWindow();
    invalidateSettingsCache();
    useUIStore.getState().setTerminalShell('auto');
    useUIStore.getState().setTerminalLoginShells([]);
    registerSettingsApi(async () => ({}), async () => ({
      settings: { terminalShell: 'zsh', terminalLoginShells: ['zsh', 'fish'] },
      source: 'web',
    }));

    await syncDesktopSettings();

    expect(useUIStore.getState().terminalShell).toBe('zsh');
    expect(useUIStore.getState().terminalLoginShells).toEqual(['zsh', 'fish']);
  });

  test('autosaves all model selector settings fields', async () => {
    getWindow();
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      return changes as SettingsPayload;
    });
    const stop = startModelPrefsAutoSave();

    try {
      useUIStore.setState({ favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-haiku-4' }] });
      await delay(20);
      useUIStore.setState({
        hiddenModels: [{ providerID: 'openai', modelID: 'gpt-5' }],
        collapsedModelProviders: ['openai'],
        recentModels: [{ providerID: 'google', modelID: 'gemini-pro' }],
        recentAgents: ['build'],
        recentEfforts: { 'openai/gpt-5': ['low'] },
      });

      await delay(1500);

      expect(saveCalls).toHaveLength(1);
      expect(saveCalls[0]).toEqual({
        favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-haiku-4' }],
        hiddenModels: [{ providerID: 'openai', modelID: 'gpt-5' }],
        collapsedModelProviders: ['openai'],
        recentModels: [{ providerID: 'google', modelID: 'gemini-pro' }],
        recentAgents: ['build'],
        recentEfforts: { 'openai/gpt-5': ['low'] },
      });
    } finally {
      stop();
    }
  });

  test('autosaves terminal shell changes to shared settings', async () => {
    getWindow();
    useUIStore.getState().setTerminalShell('auto');
    useUIStore.getState().setTerminalLoginShells([]);
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      return changes as SettingsPayload;
    });
    startAppearanceAutoSave();

    useUIStore.getState().setTerminalShell('zsh');
    useUIStore.getState().setTerminalLoginShells(['zsh']);
    await delay(500);

    expect(saveCalls.some((changes) => changes.terminalShell === 'zsh')).toBe(true);
    expect(saveCalls.some((changes) => changes.terminalLoginShells?.includes('zsh'))).toBe(true);
  });

  test('applies persisted autoSaveEnabled from server settings', async () => {
    getWindow();
    invalidateSettingsCache();
    useUIStore.getState().setAutoSaveEnabled(true);
    registerSettingsApi(async () => ({}), async () => ({
      settings: { autoSaveEnabled: false },
      source: 'web',
    }));

    await syncDesktopSettings();

    expect(useUIStore.getState().autoSaveEnabled).toBe(false);
  });

  test('merges valid file editor settings while retaining the last valid value for malformed fields', async () => {
    getWindow();
    invalidateSettingsCache();
    useUIStore.getState().updateFileEditorSettings({ tabSize: 7, wordWrap: 'off', minimap: 'profile' });
    registerSettingsApi(async () => ({}), async () => ({
      settings: {
        fileEditorSettings: { tabSize: 0, wordWrap: 'sometimes', minimap: 'on' },
      } as unknown as SettingsPayload,
      source: 'web',
    }));

    await syncDesktopSettings();

    expect(useUIStore.getState().fileEditorSettings.tabSize).toBe(7);
    expect(useUIStore.getState().fileEditorSettings.wordWrap).toBe('off');
    expect(useUIStore.getState().fileEditorSettings.minimap).toBe('on');
  });

  test('autosaves autoSaveEnabled changes to shared settings', async () => {
    getWindow();
    useUIStore.getState().setAutoSaveEnabled(true);
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      return changes as SettingsPayload;
    });
    startAppearanceAutoSave();

    useUIStore.getState().setAutoSaveEnabled(false);
    await delay(500);

    expect(saveCalls.some((changes) => changes.autoSaveEnabled === false)).toBe(true);
  });

  test('materializes the current autoSaveEnabled default without a migration write', async () => {
    getWindow();
    invalidateSettingsCache();
    useUIStore.getState().setAutoSaveEnabled(false);
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsApi(async (changes) => {
      saveCalls.push(changes);
      return { ...changes } as SettingsPayload;
    }, async () => ({
      settings: {},
      source: 'web',
    }));

    await syncDesktopSettings();
    await delay(500);

    expect(useUIStore.getState().autoSaveEnabled).toBe(true);
    expect(saveCalls).toEqual([]);
  });
});
