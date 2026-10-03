import { afterEach, describe, expect, test } from 'vitest';

import { getRuntimeKey } from '@varin/application-client';
import {
  activatePiEditorContextOwner,
  normalizePiActiveEditorFile,
  publishPiEditorContext,
  releasePiEditorContextOwner,
  resetPiEditorContext,
  usePiEditorContextStore,
} from './usePiEditorContextStore';

const editorFile = (viewId = 'view-a') => normalizePiActiveEditorFile({
  documentInstanceId: `document-${viewId}`,
  fileName: 'example.ts',
  filePath: 'D:/work/example.ts',
  fileSize: 42,
  relativePath: 'example.ts',
  runtimeKey: getRuntimeKey(),
  selection: { endLine: 4, startLine: 2, text: 'const value = 1;' },
  viewId,
  workspaceId: 'workspace-a',
});

afterEach(() => resetPiEditorContext());

describe('Pi editor context store', () => {
  test('normalizes owner and document identity without persisting it', () => {
    expect(editorFile()).toEqual({
      documentInstanceId: 'document-view-a',
      fileName: 'example.ts',
      filePath: 'D:/work/example.ts',
      fileSize: 42,
      relativePath: 'example.ts',
      runtimeKey: getRuntimeKey(),
      selection: { endLine: 4, startLine: 2, text: 'const value = 1;' },
      dirty: false,
      viewId: 'view-a',
      workspaceId: 'workspace-a',
    });
    expect(normalizePiActiveEditorFile({ fileName: 'missing-path.ts' })).toBeNull();
  });

  test('accepts a host-owned editor without inventing a Varin workspace identity', () => {
    expect(normalizePiActiveEditorFile({
      documentInstanceId: 'monaco:file:///work/example.ts:3',
      fileName: 'example.ts',
      filePath: 'D:/work/example.ts',
      fileSize: null,
      relativePath: 'example.ts',
      runtimeKey: getRuntimeKey(),
      selection: null,
      viewId: 'monaco:active-editor',
      workspaceId: null,
    })?.workspaceId).toBeNull();
  });

  test('treats an invalid or empty selection as a whole-file suggestion', () => {
    expect(normalizePiActiveEditorFile({
      documentInstanceId: 'document-view-a',
      fileName: 'example.ts',
      filePath: 'D:/work/example.ts',
      fileSize: null,
      relativePath: 'example.ts',
      runtimeKey: getRuntimeKey(),
      selection: { endLine: 1, startLine: 1, text: '' },
      viewId: 'view-a',
      workspaceId: 'workspace-a',
    })?.selection).toBeNull();
  });

  test('only the selected visible owner can publish or clear active context', () => {
    const first = editorFile('view-a');
    const second = editorFile('view-b');
    if (!first || !second) throw new Error('expected normalized fixtures');
    publishPiEditorContext('view:view-a', first);
    publishPiEditorContext('view:view-b', second);
    expect(usePiEditorContextStore.getState().activeEditorFile).toBeNull();

    activatePiEditorContextOwner('view:view-a');
    const activeFirst = usePiEditorContextStore.getState().activeEditorFile;
    expect(activeFirst).toEqual(first);
    publishPiEditorContext('view:view-a', { ...first });
    expect(usePiEditorContextStore.getState().activeEditorFile).toBe(activeFirst);
    publishPiEditorContext('view:view-b', { ...second, dirty: true });
    expect(usePiEditorContextStore.getState().activeEditorFile).toBe(activeFirst);

    activatePiEditorContextOwner('view:view-b');
    expect(usePiEditorContextStore.getState().activeEditorFile?.dirty).toBe(true);
    releasePiEditorContextOwner('view:view-a');
    expect(usePiEditorContextStore.getState().activeEditorFile?.viewId).toBe('view-b');
    releasePiEditorContextOwner('view:view-b');
    expect(usePiEditorContextStore.getState().activeEditorFile).toBeNull();
  });
});
