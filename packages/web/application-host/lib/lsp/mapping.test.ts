import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  mapCodeAction,
  mapCompletionItem,
  mapWorkspaceEdit,
  resourceFromUri,
  strictLocationRejection,
} from './mapping.js';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const root = path.resolve('D:/workspace');
const context = { workspaceId, root, pathModule: path };

describe('LSP mapping boundary', () => {
  it('only projects file URIs inside the workspace authority', () => {
    expect(resourceFromUri(pathToFileURL(path.join(root, 'src', 'file.ts')).href, workspaceId, root, path)).toEqual({
      workspaceId,
      resourceId: 'src/file.ts',
    });
    expect(resourceFromUri(pathToFileURL(path.resolve(root, '..', 'outside.ts')).href, workspaceId, root, path)).toBeNull();
    expect(resourceFromUri('https://example.com/file.ts', workspaceId, root, path)).toBeNull();
  });

  it.each([
    [String.raw`\\?\C:\Workspace`, 'file:///C:/Workspace/src/File.ts'],
    [String.raw`\\?\UNC\server\share\Workspace`, 'file://server/share/Workspace/src/File.ts'],
  ])('maps a Win32 source namespace and its ordinary file URI: %s', (root, uri) => {
    expect(resourceFromUri(uri, workspaceId, root, path.win32)).toEqual({ workspaceId, resourceId: 'src/File.ts' });
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
    expect(strictLocationRejection({ uri, range }, root, path.win32)).toBeUndefined();
    expect(resourceFromUri(uri.replace('/Workspace/', '/Other/'), workspaceId, root, path.win32)).toBeNull();
  });

  it('preserves completion edits and normalized workspace operations', () => {
    expect(mapCompletionItem({
      label: 'fixture',
      insertTextFormat: 2,
      textEdit: {
        insert: { start: { line: 1, character: 2 }, end: { line: 1, character: 2 } },
        replace: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } },
        newText: 'fixture(${1:value})',
      },
      additionalTextEdits: [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: 'import fixture\n',
      }],
    }, '2:1')).toMatchObject({
      insertTextFormat: 'snippet',
      textEdit: { newText: 'fixture(${1:value})' },
      additionalTextEdits: [{ newText: 'import fixture\n' }],
      resolveToken: '2:1',
    });

    const source = pathToFileURL(path.join(root, 'src', 'old.ts')).href;
    const target = pathToFileURL(path.join(root, 'src', 'new.ts')).href;
    expect(mapWorkspaceEdit({
      documentChanges: [
        {
          textDocument: { uri: source, version: 4 },
          edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'new' }],
        },
        { kind: 'rename', oldUri: source, newUri: target, options: { overwrite: true } },
      ],
      changeAnnotations: { refactor: { label: 'Rename fixture', needsConfirmation: true } },
    }, context)).toMatchObject({
      documentChanges: [
        { kind: 'text', version: 4, edits: [{ newText: 'new' }] },
        { kind: 'rename', overwrite: true },
      ],
      changeAnnotations: { refactor: { label: 'Rename fixture', needsConfirmation: true } },
    });
  });

  it('keeps code-action edit and command data together', () => {
    const uri = pathToFileURL(path.join(root, 'src', 'file.ts')).href;
    const action = mapCodeAction({
      title: 'Fix fixture',
      kind: 'quickfix',
      edit: { changes: { [uri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'x' }] } },
      command: { title: 'Finish', command: 'fixture.finish', arguments: ['done'] },
    }, {
      ...context,
      diagnosticContext: {
        ...context,
        resource: { workspaceId, resourceId: 'src/file.ts' },
        documentVersion: 1,
        severity: () => 'info',
        providerId: 'fixture',
        generation: 1,
      },
    });
    expect(action).toMatchObject({
      title: 'Fix fixture',
      edit: { documentChanges: [{ kind: 'text', edits: [{ newText: 'x' }] }] },
      command: { command: 'fixture.finish', arguments: ['done'] },
    });
  });

  it('rejects an entire workspace edit instead of silently dropping an external target', () => {
    const outside = pathToFileURL(path.resolve(root, '..', 'outside.ts')).href;
    expect(() => mapWorkspaceEdit({
      changes: {
        [outside]: [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          newText: 'x',
        }],
      },
    }, context)).toThrow(/unsupported resource/i);
  });
});
