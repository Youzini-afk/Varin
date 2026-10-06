import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContextResourceEditor } from './ContextResourceEditor';
import { openWorkbenchEditor, patchEditorViewState, resetEditorWorkbenchForTests } from '@/lib/workbench/editors/session';
import { activeEditorTab } from '@/lib/workbench/editors/groups';

const mocks = vi.hoisted(() => ({ documents: { resolveWorkspace: vi.fn() }, editor: vi.fn() }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ documents: mocks.documents }) }));
vi.mock('@varin/application-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@varin/application-client')>(),
  getRuntimeEndpointGeneration: () => 1,
  subscribeRuntimeEndpointChanged: () => () => {},
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/workbench/editors/providers', () => ({ resolveEditorProviderId: () => 'varin.text' }));
vi.mock('./ResourceEditorHost', () => ({ ResourceEditorHost: (props: { workspaceRoot: string }) => {
  mocks.editor(props); return <div>{props.workspaceRoot}</div>;
} }));

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  resetEditorWorkbenchForTests();
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  resetEditorWorkbenchForTests();
});

it('opens the same editor view in the adjacent surface with its saved location and preview mode', async () => {
  mocks.documents.resolveWorkspace.mockResolvedValue({ workspaceId: 'shared-workspace' });
  const workbench = openWorkbenchEditor('shared-workspace', 'paper.md');
  const tab = activeEditorTab(workbench)!;
  patchEditorViewState('shared-workspace', tab.viewId, { previewMode: 'edit', diffLayout: 'inline' });
  await act(async () => root.render(<ContextResourceEditor filePath="/selected/paper.md" workspaceRoot="/selected" viewId="adjacent" editorViewId={tab.viewId} />));
  expect(mocks.editor).toHaveBeenLastCalledWith(expect.objectContaining({
    workspaceId: 'shared-workspace', tab: expect.objectContaining({ viewId: tab.viewId, viewState: expect.objectContaining({ previewMode: 'edit', diffLayout: 'inline' }) }),
  }));
});

it('resolves the file repository through DocumentsAPI and ignores a late previous repository', async () => {
  let finishPrevious!: (result: { workspaceId: string }) => void;
  mocks.documents.resolveWorkspace.mockImplementation(({ path }: { path: string }) => path === '/previous'
    ? new Promise((resolve) => { finishPrevious = resolve; })
    : Promise.resolve({ workspaceId: 'selected-workspace' }));
  await act(async () => root.render(<ContextResourceEditor filePath="/previous/a.ts" workspaceRoot="/previous" viewId="file" />));
  expect(container.querySelector('[role="status"]')).not.toBeNull();
  await act(async () => root.render(<ContextResourceEditor filePath="/selected/src/main.ts" workspaceRoot="/selected" viewId="file" />));
  await act(async () => finishPrevious({ workspaceId: 'previous-workspace' }));
  expect(mocks.documents.resolveWorkspace).toHaveBeenCalledWith({ path: '/selected' });
  expect(mocks.editor).toHaveBeenLastCalledWith(expect.objectContaining({
    workspaceId: 'selected-workspace', workspaceRoot: '/selected',
    tab: expect.objectContaining({ resourceId: 'src/main.ts' }),
  }));
  expect(container.textContent).toBe('/selected');
});

it('reports a workspace resolution failure without mounting an editor with another workspace identity', async () => {
  mocks.documents.resolveWorkspace.mockRejectedValue(new Error('Repository is unavailable'));
  await act(async () => root.render(<ContextResourceEditor filePath="/selected/main.ts" workspaceRoot="/selected" viewId="file" />));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Repository is unavailable');
  expect(mocks.editor).not.toHaveBeenCalled();
});
