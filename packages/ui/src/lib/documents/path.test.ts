import { describe, expect, test } from 'vitest';
import { resourceIdFromWorkspacePath, workspacePathFromResourceId, documentIdentityForPath } from './path';

describe('document resource paths', () => {
  test('maps workspace-relative posix paths', () => {
    expect(resourceIdFromWorkspacePath('/repo', '/repo/src/note.txt')).toBe('src/note.txt');
    expect(workspacePathFromResourceId('/repo', 'src/note.txt')).toBe('/repo/src/note.txt');
  });

  test('rejects paths outside the workspace', () => {
    expect(resourceIdFromWorkspacePath('/repo', '/other/note.txt')).toBeNull();
  });

  test('resolves a repository-relative path into a resource ID', () => {
    // Git reports repository-relative paths, so callers must join before deriving a resource ID.
    // Passing the relative path straight to resourceIdFromWorkspacePath yields null.
    const root = 'C:/work/repo';
    expect(resourceIdFromWorkspacePath(root, 'src/note.txt')).toBeNull();
    expect(
      resourceIdFromWorkspacePath(root, workspacePathFromResourceId(root, 'src/note.txt')),
    ).toBe('src/note.txt');
  });

  test('a joined path that escapes the workspace is still rejected', () => {
    const root = '/repo';
    expect(workspacePathFromResourceId(root, '/etc/passwd')).toBe('/repo/etc/passwd');
    expect(resourceIdFromWorkspacePath(root, '/etc/passwd')).toBeNull();
  });

  test('builds a document identity only for in-workspace paths', () => {
    expect(documentIdentityForPath('ws-1', '/repo', '/repo/src/note.txt')).toEqual({
      workspaceId: 'ws-1',
      resourceId: 'src/note.txt',
    });
    expect(documentIdentityForPath('ws-1', '/repo', '/other/note.txt')).toBeUndefined();
    expect(documentIdentityForPath(undefined, '/repo', '/repo/src/note.txt')).toBeUndefined();
  });
});
