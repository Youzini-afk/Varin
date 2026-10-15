import { beforeEach, describe, expect, test, vi } from 'vitest';
import { openFileInMainEditor } from './openFileInMainEditor';
import { getResolvedWorkbenchWorkspaceId, setWorkbenchWorkspaceResolutionForTests } from '@/lib/extensions/workbench-workspace';
import { activeEditorTab } from '@/lib/workbench/editors/groups';
import { peekEditorWorkbench, resetEditorWorkbenchForTests } from '@/lib/workbench/editors/session';
import { useUIStore } from '@/stores/useUIStore';

const runtime = vi.hoisted(() => ({ generation: 1 }));
vi.mock('@varin/application-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@varin/application-client')>(),
  getRuntimeEndpointGeneration: () => runtime.generation,
}));

const resetStores = () => {
  resetEditorWorkbenchForTests();
  setWorkbenchWorkspaceResolutionForTests();
  useUIStore.setState({
    activeMainTab: 'chat',
    pendingFileFocusPath: null,
    pendingFileNavigation: null,
  });
};

describe('openFileInMainEditor', () => {
  beforeEach(() => {
    runtime.generation = 1;
    resetStores();
  });

  test('opens files in the shared files view', async () => {
    setWorkbenchWorkspaceResolutionForTests('/repo', 'workspace-1');
    const opened = openFileInMainEditor('/repo', '/repo/src/index.ts');

    expect(opened).toBe(true);
    expect(useUIStore.getState().activeMainTab).toBe('files');
    const workbench = peekEditorWorkbench('workspace-1');
    expect(workbench ? activeEditorTab(workbench)?.resourceId : undefined).toBe('src/index.ts');
  });

  test('rejects the previous runtime workspace before React resolves the new owner, preserving Windows path equivalence', () => {
    setWorkbenchWorkspaceResolutionForTests('C:\\Repo\\', 'old-runtime-workspace');
    expect(getResolvedWorkbenchWorkspaceId('c:/repo')).toBe('old-runtime-workspace');
    // Runtime generation changes before the Workbench resolution effect can publish loading.
    runtime.generation += 1;
    expect(getResolvedWorkbenchWorkspaceId('c:/repo')).toBeUndefined();
    expect(openFileInMainEditor('c:/repo', 'c:/repo/src/index.ts')).toBe(false);
    expect(peekEditorWorkbench('old-runtime-workspace')).toBeUndefined();
    setWorkbenchWorkspaceResolutionForTests('C:\\Repo\\', 'new-runtime-workspace');
    expect(getResolvedWorkbenchWorkspaceId('c:/repo/')).toBe('new-runtime-workspace');
    expect(openFileInMainEditor('c:/repo', 'c:/repo/src/index.ts')).toBe(true);
    const workbench = peekEditorWorkbench('new-runtime-workspace');
    expect(workbench ? activeEditorTab(workbench)?.resourceId : undefined).toBe('src/index.ts');
  });

});
