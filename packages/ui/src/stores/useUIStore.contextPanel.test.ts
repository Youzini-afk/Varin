import { beforeEach, describe, expect, test } from 'vitest';
import { getContextRailMode, sortContextSurfaces } from '../lib/surfaces/registry';
import { useUIStore } from './useUIStore';

beforeEach(() => {
  useUIStore.setState({ contextPanelByDirectory: {}, contextRailOrder: [] });
});

describe('useUIStore context panel tabs', () => {
  test('updates readOnly when an existing chat tab is reopened', () => {
    const directory = '/repo';

    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'chat',
      dedupeKey: 'session:ses_1',
      label: 'Session',
      readOnly: true,
    });

    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'chat',
      dedupeKey: 'session:ses_1',
      label: 'Session',
      readOnly: false,
    });

    const tabs = useUIStore.getState().contextPanelByDirectory[directory]?.tabs ?? [];
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.readOnly).toBe(false);
  });
});

describe('useUIStore openContextSurface', () => {
  const directory = '/repo';

  test('opens a fresh singleton tab when none of that mode exists', () => {
    useUIStore.getState().openContextSurface(directory, 'diff');

    const state = useUIStore.getState().contextPanelByDirectory[directory];
    expect(state?.isOpen).toBe(true);
    expect(state?.tabs.map((tab) => tab.mode)).toEqual(['diff']);
  });

  test('opens recovery as a persistent singleton surface', () => {
    useUIStore.getState().openContextSurface(directory, 'recovery');
    useUIStore.getState().setContextPanelWidth(directory, 'recovery', 640);

    let state = useUIStore.getState().contextPanelByDirectory[directory];
    expect(state?.isOpen).toBe(true);
    expect(state?.tabs.map((tab) => tab.mode)).toEqual(['recovery']);
    expect(state?.widthByMode.recovery).toBe(640);

    useUIStore.getState().openContextSurface(directory, 'recovery');
    state = useUIStore.getState().contextPanelByDirectory[directory];
    expect(state?.isOpen).toBe(false);
    expect(state?.tabs.map((tab) => tab.mode)).toEqual(['recovery']);
  });

  test('activates the existing tab of the requested mode instead of duplicating it', () => {
    useUIStore.getState().openContextPanelTab(directory, { mode: 'diff' });
    useUIStore.getState().openContextPanelTab(directory, { mode: 'file', targetPath: '/repo/a.ts' });

    useUIStore.getState().openContextSurface(directory, 'diff');

    const state = useUIStore.getState().contextPanelByDirectory[directory];
    expect(state?.tabs.filter((tab) => tab.mode === 'diff')).toHaveLength(1);
    expect(state?.activeTabId).toBe('diff');
    expect(state?.isOpen).toBe(true);
  });

  test('toggles the panel closed when the requested mode is already active and open', () => {
    useUIStore.getState().openContextSurface(directory, 'diff');
    useUIStore.getState().openContextSurface(directory, 'diff');

    const state = useUIStore.getState().contextPanelByDirectory[directory];
    expect(state?.isOpen).toBe(false);
    expect(state?.tabs.map((tab) => tab.mode)).toEqual(['diff']);
  });

  for (const mode of ['pr', 'diff'] as const) {
    test(`the Git entry closes and restores its ${mode} page without changing the repository`, () => {
      useUIStore.getState().openContextPanelTab(directory, { mode: 'git' });
      useUIStore.getState().openContextPanelTab(directory, {
        mode, targetDirectory: 'D:\\other-repo', targetPath: mode === 'diff' ? 'src/main.ts' : null,
      });
      useUIStore.getState().openContextSurface(directory, 'git');
      expect(useUIStore.getState().contextPanelByDirectory[directory]?.isOpen).toBe(false);
      useUIStore.getState().openContextSurface(directory, 'git');
      const state = useUIStore.getState().contextPanelByDirectory[directory];
      const active = state?.tabs.find((tab) => tab.id === state.activeTabId);
      expect(state?.isOpen).toBe(true);
      expect(active?.mode).toBe(mode);
      expect(active?.targetDirectory).toBe('D:/other-repo');
      expect(getContextRailMode(active!.mode)).toBe('git');
      expect(state?.tabs).toHaveLength(2);
    });
  }

  test('direct diff navigation retains its source repository', () => {
    useUIStore.getState().openContextDiff(directory, 'src/main.ts', true);
    const tab = useUIStore.getState().contextPanelByDirectory[directory]?.tabs[0];
    expect(tab?.targetDirectory).toBe(directory);
    expect(tab?.targetPath).toBe('src/main.ts');
    expect(tab?.diffScope).toBe('staged');
  });

  test('opening a source line from another repository separates its resource root from the panel location', () => {
    useUIStore.getState().openContextFileAtLine(directory, '/selected-repo/src/main.ts', 12, 3, '/selected-repo');
    const state = useUIStore.getState();
    const tab = state.contextPanelByDirectory[directory]?.tabs[0];
    expect(tab?.mode).toBe('file');
    expect(tab?.targetDirectory).toBe('/selected-repo');
    expect(tab?.targetPath).toBe('/selected-repo/src/main.ts');
    expect(state.pendingFileNavigation).toEqual({ path: '/selected-repo/src/main.ts', line: 12, column: 3 });
    expect(state.contextPanelByDirectory['/selected-repo']).toBeUndefined();
  });

  test('does nothing for content-driven modes without existing content', () => {
    useUIStore.getState().openContextSurface(directory, 'chat');

    expect(useUIStore.getState().contextPanelByDirectory[directory]).toBe(undefined);
  });

  test('opens the preview launcher and replaces it when the server URL arrives', () => {
    useUIStore.getState().openContextSurface(directory, 'preview');
    expect(useUIStore.getState().contextPanelByDirectory[directory]?.tabs[0]?.targetPath).toBe(null);
    useUIStore.getState().openContextPreview(directory, 'http://localhost:3000');
    const tabs = useUIStore.getState().contextPanelByDirectory[directory]?.tabs ?? [];
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.targetPath).toBe('http://localhost:3000');
  });

  test('opens an empty editor tab that a real file later replaces', () => {
    useUIStore.getState().openContextSurface(directory, 'file');

    let state = useUIStore.getState().contextPanelByDirectory[directory];
    expect(state?.isOpen).toBe(true);
    expect(state?.tabs.map((tab) => tab.mode)).toEqual(['file']);
    expect(state?.tabs[0]?.targetPath).toBe(null);

    useUIStore.getState().openContextFile(directory, '/repo/a.ts');

    state = useUIStore.getState().contextPanelByDirectory[directory];
    expect(state?.tabs.filter((tab) => tab.mode === 'file')).toHaveLength(1);
    expect(state?.tabs.find((tab) => tab.mode === 'file')?.targetPath).toBe('/repo/a.ts');
  });

  test('activates the most recently touched tab of a content-driven mode', () => {
    useUIStore.getState().openContextFile(directory, '/repo/a.ts');
    useUIStore.getState().openContextFile(directory, '/repo/b.ts');
    useUIStore.getState().openContextPanelTab(directory, { mode: 'diff' });

    useUIStore.getState().openContextSurface(directory, 'file');

    const state = useUIStore.getState().contextPanelByDirectory[directory];
    const activeTab = state?.tabs.find((tab) => tab.id === state.activeTabId);
    expect(activeTab?.mode).toBe('file');
    expect(activeTab?.targetPath).toBe('/repo/b.ts');
  });
});

describe('useUIStore closeContextPanelTab surface stability', () => {
  const directory = '/repo';

  test('closing an active file tab activates another file tab, not another surface', () => {
    useUIStore.getState().openContextPanelTab(directory, { mode: 'terminal' });
    useUIStore.getState().openContextFile(directory, '/repo/a.ts');
    useUIStore.getState().openContextFile(directory, '/repo/b.ts');

    const stateBefore = useUIStore.getState().contextPanelByDirectory[directory];
    const activeTabId = stateBefore?.activeTabId as string;
    useUIStore.getState().closeContextPanelTab(directory, activeTabId);

    const state = useUIStore.getState().contextPanelByDirectory[directory];
    const activeTab = state?.tabs.find((tab) => tab.id === state.activeTabId);
    expect(activeTab?.mode).toBe('file');
    expect(activeTab?.targetPath).toBe('/repo/a.ts');
    expect(state?.isOpen).toBe(true);
  });

  test('closing the last tab of the active surface closes the panel', () => {
    useUIStore.getState().openContextPanelTab(directory, { mode: 'terminal' });
    useUIStore.getState().openContextFile(directory, '/repo/a.ts');

    const stateBefore = useUIStore.getState().contextPanelByDirectory[directory];
    useUIStore.getState().closeContextPanelTab(directory, stateBefore?.activeTabId as string);

    const state = useUIStore.getState().contextPanelByDirectory[directory];
    expect(state?.isOpen).toBe(false);
    expect(state?.tabs.map((tab) => tab.mode)).toEqual(['terminal']);
  });

  test('closing an inactive tab keeps the active tab untouched', () => {
    useUIStore.getState().openContextFile(directory, '/repo/a.ts');
    useUIStore.getState().openContextPanelTab(directory, { mode: 'terminal' });

    const state0 = useUIStore.getState().contextPanelByDirectory[directory];
    const fileTab = state0?.tabs.find((tab) => tab.mode === 'file');
    useUIStore.getState().closeContextPanelTab(directory, fileTab?.id as string);

    const state = useUIStore.getState().contextPanelByDirectory[directory];
    expect(state?.activeTabId).toBe('terminal');
    expect(state?.isOpen).toBe(true);
  });
});

describe('useUIStore computer surface (BC8)', () => {
  const directory = '/repo';

  test('opens a singleton computer tab and persists a per-desktop tab by dedupe key', () => {
    useUIStore.getState().openContextSurface(directory, 'computer');
    let state = useUIStore.getState().contextPanelByDirectory[directory];
    expect(state?.isOpen).toBe(true);
    expect(state?.tabs.map((tab) => tab.mode)).toEqual(['computer']);

    // A desktop-targeted tab reuses its dedupe key instead of duplicating.
    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'computer',
      dedupeKey: 'desktop:local-console',
      targetPath: 'local-console',
      label: 'Console session',
    });
    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'computer',
      dedupeKey: 'desktop:local-console',
      targetPath: 'local-console',
      label: 'Console session',
    });
    state = useUIStore.getState().contextPanelByDirectory[directory];
    const computerTabs = state?.tabs.filter((tab) => tab.mode === 'computer') ?? [];
    expect(computerTabs).toHaveLength(2);
    expect(computerTabs.find((tab) => tab.targetPath === 'local-console')).toBeDefined();
  });

  test('setContextPanelTabTargetPath rebinds the desktop on the tab', () => {
    useUIStore.getState().openContextPanelTab(directory, { mode: 'computer' });
    const tabId = useUIStore.getState().contextPanelByDirectory[directory]?.tabs[0]?.id as string;
    useUIStore.getState().setContextPanelTabTargetPath(directory, tabId, 'remote:r1:d0');
    const tab = useUIStore.getState().contextPanelByDirectory[directory]?.tabs[0];
    expect(tab?.targetPath).toBe('remote:r1:d0');
  });
});

describe('useUIStore per-surface panel widths', () => {
  const directory = '/repo';

  test('setContextPanelWidth stores a clamped manual width for one mode only', () => {
    useUIStore.getState().openContextPanelTab(directory, { mode: 'diff' });
    useUIStore.getState().setContextPanelWidth(directory, 'diff', 700);
    useUIStore.getState().setContextPanelWidth(directory, 'git', 100);

    const state = useUIStore.getState().contextPanelByDirectory[directory];
    expect(state?.widthByMode.diff).toBe(700);
    expect(state?.widthByMode.git).toBe(380);
    expect(state?.widthByMode.browser).toBe(undefined);
  });
});

describe('useUIStore contextRailOrder', () => {
  test('setContextRailOrder drops empty and duplicate ids', () => {
    useUIStore.getState().setContextRailOrder(['diff', 'diff', '', 'editor']);
    expect(useUIStore.getState().contextRailOrder).toEqual(['diff', 'editor']);
  });

  test('sortContextSurfaces applies persisted order and appends missing surfaces', () => {
    const ordered = sortContextSurfaces(['browser', 'unknown-id', 'pr', 'diff', 'git', 'git']);
    const ids = ordered.map((surface) => surface.id);

    expect(ids.slice(0, 2)).toEqual(['browser', 'git']);
    expect(ids).not.toContain('pr');
    expect(ids).not.toContain('diff');
    expect(ids).toContain('editor');
    expect(ids.filter((id) => id === 'git')).toHaveLength(1);
  });
});
