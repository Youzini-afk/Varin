import { expect, it, vi } from 'vitest';
import type { DocumentsAPI } from '@varin/application-client';
import { holdEditorWorkspace, retainEditorWorkspace } from './workspace-retention';

it('keeps a source while either an independent file view or a saved editor tab still uses it', async () => {
  const setWorkspaceRetention = vi.fn(async () => undefined);
  const documents = { setWorkspaceRetention } as unknown as DocumentsAPI;
  const workspace = 'source-shared-by-file-views-and-editor';
  await retainEditorWorkspace(documents, workspace, true);
  const first = holdEditorWorkspace(documents, workspace);
  const second = holdEditorWorkspace(documents, workspace);
  await retainEditorWorkspace(documents, workspace, false);
  expect(setWorkspaceRetention).toHaveBeenLastCalledWith(expect.objectContaining({ retained: true }));
  await first();
  expect(setWorkspaceRetention).toHaveBeenLastCalledWith(expect.objectContaining({ retained: true }));
  await second();
  expect(setWorkspaceRetention).toHaveBeenLastCalledWith(expect.objectContaining({ retained: false }));

  const fileView = holdEditorWorkspace(documents, workspace);
  await retainEditorWorkspace(documents, workspace, true);
  await fileView();
  expect(setWorkspaceRetention).toHaveBeenLastCalledWith(expect.objectContaining({ retained: true }));
  await retainEditorWorkspace(documents, workspace, false);
  expect(setWorkspaceRetention).toHaveBeenLastCalledWith(expect.objectContaining({ retained: false }));
});

it('does not release another resource owner with the same Documents workspace ID', async () => {
  const a = { setWorkspaceRetention: vi.fn(async () => undefined) } as unknown as DocumentsAPI;
  const b = { setWorkspaceRetention: vi.fn(async () => undefined) } as unknown as DocumentsAPI;
  const release = holdEditorWorkspace(a, 'identical-id');
  await retainEditorWorkspace(b, 'identical-id', true);
  await release();
  expect(a.setWorkspaceRetention).toHaveBeenLastCalledWith(expect.objectContaining({ retained: false }));
  expect(b.setWorkspaceRetention).toHaveBeenLastCalledWith(expect.objectContaining({ retained: true }));
});
