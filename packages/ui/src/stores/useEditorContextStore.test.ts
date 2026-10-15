import { afterEach, describe, expect, test } from 'vitest';

import { threadHostKey as getRuntimeKey } from './useThreadStore';
import {
  activateEditorContextOwner,
  normalizeActiveEditorFile,
  publishEditorContext,
  releaseEditorContextOwner,
  resetEditorContext,
  useEditorContextStore,
} from './useEditorContextStore';

const editorFile = (viewId = 'view-a') => normalizeActiveEditorFile({
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

afterEach(() => resetEditorContext());

describe('editor context ownership', () => {
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
    expect(normalizeActiveEditorFile({ fileName: 'missing-path.ts' })).toBeNull();
  });

  test('accepts a host-owned editor without inventing a Varin workspace identity', () => {
    expect(normalizeActiveEditorFile({
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
    expect(normalizeActiveEditorFile({
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
    publishEditorContext('view:view-a', first);
    publishEditorContext('view:view-b', second);
    expect(useEditorContextStore.getState().activeEditorFile).toBeNull();

    activateEditorContextOwner('view:view-a');
    const activeFirst = useEditorContextStore.getState().activeEditorFile;
    expect(activeFirst).toEqual(first);
    publishEditorContext('view:view-a', { ...first });
    expect(useEditorContextStore.getState().activeEditorFile).toBe(activeFirst);
    publishEditorContext('view:view-b', { ...second, dirty: true });
    expect(useEditorContextStore.getState().activeEditorFile).toBe(activeFirst);

    activateEditorContextOwner('view:view-b');
    expect(useEditorContextStore.getState().activeEditorFile?.dirty).toBe(true);
    releaseEditorContextOwner('view:view-a');
    expect(useEditorContextStore.getState().activeEditorFile?.viewId).toBe('view-b');
    releaseEditorContextOwner('view:view-b');
    expect(useEditorContextStore.getState().activeEditorFile).toBeNull();
  });
});
