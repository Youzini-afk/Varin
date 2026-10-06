import { afterEach, expect, it, vi } from 'vitest';
import { VARIN_WORKBENCH_DEFAULT_PROFILE_ID, VARIN_WORKBENCH_IDE_PROFILE_ID } from '@varin/extension-contract';
import { activeEditorTab, listEditorGroups } from '@/lib/workbench/editors/groups';
import { openWorkbenchEditor, patchEditorViewState, peekEditorWorkbench, resetEditorWorkbenchForTests } from '@/lib/workbench/editors/session';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { continueMaterialInIde, returnMaterialToConversation } from './material-navigation';

const mocks = vi.hoisted(() => ({ select: vi.fn(async () => undefined), runtimeKey: 'material-runtime' }));
vi.mock('@/lib/extensions/workbench-shell-transition', () => ({ selectActiveWorkbenchProfile: mocks.select }));
vi.mock('@varin/application-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@varin/application-client')>(), getRuntimeKey: () => mocks.runtimeKey,
}));

afterEach(() => {
  resetEditorWorkbenchForTests();
  useUIStore.setState({ contextPanelByDirectory: {} });
  mocks.runtimeKey = 'material-runtime';
  mocks.select.mockReset().mockResolvedValue(undefined);
});

it('continues and returns the exact material view with its editor choices intact', async () => {
  const workspaceId = 'material-workspace';
  const tab = activeEditorTab(openWorkbenchEditor(workspaceId, 'src/main.ts', undefined, { preview: true }))!;
  patchEditorViewState(workspaceId, tab.viewId, { diffLayout: 'inline', previewMode: 'edit' });
  await continueMaterialInIde({ workspaceId, viewId: tab.viewId, fromProfileId: VARIN_WORKBENCH_DEFAULT_PROFILE_ID });
  expect(mocks.select).toHaveBeenLastCalledWith(VARIN_WORKBENCH_IDE_PROFILE_ID, undefined, { enableShell: true });
  expect(listEditorGroups(peekEditorWorkbench(workspaceId)!.tree).flatMap(group => group.tabs)).toHaveLength(1);
  expect(activeEditorTab(peekEditorWorkbench(workspaceId)!)?.viewState.diffLayout).toBe('inline');
  await returnMaterialToConversation(workspaceId, '/workspace');
  expect(mocks.select).toHaveBeenLastCalledWith(VARIN_WORKBENCH_DEFAULT_PROFILE_ID, undefined, { enableShell: true });
  const panel = useUIStore.getState().contextPanelByDirectory[normalizeContextPanelDirectoryKey('/workspace')];
  expect(panel?.isOpen).toBe(true);
  expect(panel?.tabs.find(candidate => candidate.id === panel.activeTabId)).toMatchObject({
    mode: 'file', targetPath: '/workspace/src/main.ts', editorViewId: tab.viewId,
  });
});

it('does not finalize a material action after the runtime changes during profile selection', async () => {
  const workspaceId = 'material-workspace';
  const tab = activeEditorTab(openWorkbenchEditor(workspaceId, 'paper.md', undefined, { preview: true }))!;
  mocks.select.mockImplementationOnce(async () => { mocks.runtimeKey = 'different-runtime'; });
  await continueMaterialInIde({ workspaceId, viewId: tab.viewId, fromProfileId: VARIN_WORKBENCH_DEFAULT_PROFILE_ID });
  expect(activeEditorTab(peekEditorWorkbench(workspaceId)!)?.preview).toBe(true);
});
