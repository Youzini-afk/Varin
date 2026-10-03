import { beforeEach, describe, expect, test } from 'vitest';
import { openFileInMainEditor } from './openFileInMainEditor';
import { setWorkbenchWorkspaceResolutionForTests } from '@/lib/extensions/workbench-workspace';
import { activeEditorTab } from '@/lib/workbench/editors/groups';
import { peekEditorWorkbench, resetEditorWorkbenchForTests } from '@/lib/workbench/editors/session';
import { useUIStore } from '@/stores/useUIStore';

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
});
