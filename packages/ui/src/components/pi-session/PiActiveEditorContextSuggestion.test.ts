import { describe, expect, test } from 'vitest';
import { createPiEditorContextDraft } from '@/lib/pi-runtime/editorContext';

const file = {
  documentInstanceId: 'document-agent',
  fileName: 'agent.ts',
  filePath: 'D:/work/src/agent.ts',
  fileSize: 120,
  relativePath: 'src/agent.ts',
  runtimeKey: 'runtime-a',
  selection: { endLine: 9, startLine: 7, text: 'const agent = createAgent();' },
  dirty: false,
  viewId: 'view-agent',
  workspaceId: 'workspace-a',
};

describe('Pi active editor context', () => {
  test('maps an editor selection to a Pi inline context draft', () => {
    expect(createPiEditorContextDraft(file, 'selection')).toEqual({
      code: 'const agent = createAgent();',
      endLine: 9,
      fileLabel: 'src/agent.ts',
      language: 'ts',
      source: 'editor-selection',
      startLine: 7,
      text: '',
    });
  });

  test('maps a whole editor file to a path context draft', () => {
    expect(createPiEditorContextDraft(file, 'file')).toEqual({
      code: 'D:/work/src/agent.ts',
      endLine: 0,
      fileLabel: 'src/agent.ts',
      language: '',
      source: 'editor-file',
      startLine: 0,
      text: '',
    });
  });
});
