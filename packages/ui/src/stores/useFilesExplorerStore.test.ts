import { beforeEach, describe, expect, test } from 'vitest';
import { useFilesExplorerStore } from './useFilesExplorerStore';

beforeEach(() => {
  useFilesExplorerStore.setState({
    activeRuntimeKey: 'runtime-a',
    byRoot: {},
    runtimeSnapshots: {},
  });
});

describe('files explorer state', () => {
  test('persists expanded paths without owning editor tabs', () => {
    const store = useFilesExplorerStore.getState();
    store.expandPaths('/repo', ['/repo/src', '/repo/src/components']);
    expect(useFilesExplorerStore.getState().byRoot['/repo']?.expandedPaths).toEqual([
      '/repo/src',
      '/repo/src/components',
    ]);
    store.toggleExpandedPath('/repo', '/repo/src');
    expect(useFilesExplorerStore.getState().byRoot['/repo']?.expandedPaths).toEqual([
      '/repo/src/components',
    ]);
  });

  test('consumes legacy open paths once for Editor Workbench migration', () => {
    useFilesExplorerStore.setState({
      byRoot: {
        '/repo': {
          expandedPaths: ['/repo/src'],
          legacyOpenPaths: ['/repo/a.ts', '/repo/b.ts'],
          legacySelectedPath: '/repo/b.ts',
          touchedAt: Date.now(),
        },
      },
    });
    expect(useFilesExplorerStore.getState().consumeLegacyEditorTabs('/repo')).toEqual({
      openPaths: ['/repo/a.ts', '/repo/b.ts'],
      selectedPath: '/repo/b.ts',
    });
    expect(useFilesExplorerStore.getState().consumeLegacyEditorTabs('/repo')).toEqual({
      openPaths: [],
      selectedPath: null,
    });
    expect(useFilesExplorerStore.getState().byRoot['/repo']?.expandedPaths).toEqual(['/repo/src']);
  });

  test('keeps Windows roots isolated across runtime switches', () => {
    const store = useFilesExplorerStore.getState();
    store.expandPath('C:\\Repo', 'C:\\Repo\\src');
    store.resetForRuntimeSwitch('runtime-b');
    expect(useFilesExplorerStore.getState().byRoot).toEqual({});
    useFilesExplorerStore.getState().expandPath('D:\\Repo', 'D:\\Repo\\src');
    useFilesExplorerStore.getState().resetForRuntimeSwitch('runtime-a');
    expect(useFilesExplorerStore.getState().byRoot['C:/Repo']?.expandedPaths).toEqual(['C:/Repo/src']);
  });

  test('does not truncate a legitimate large expansion set with a guessed cap', () => {
    const paths = Array.from({ length: 700 }, (_, index) => `/repo/packages/package-${index}`);
    useFilesExplorerStore.getState().expandPaths('/repo', paths);
    expect(useFilesExplorerStore.getState().byRoot['/repo']?.expandedPaths).toHaveLength(paths.length);
  });
});
