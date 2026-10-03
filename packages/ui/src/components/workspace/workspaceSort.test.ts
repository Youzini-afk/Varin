import { describe, expect, test } from 'vitest';
import type { WorkspaceEntry } from '@varin/application-client';
import { normalizeWorkspaceSortMode, sortWorkspaceEntries } from './workspaceSort';

const entry = (name: string, type: WorkspaceEntry['type'], mtimeMs: number): WorkspaceEntry => ({
  name,
  type,
  mtimeMs,
  modifiedAt: new Date(mtimeMs).toISOString(),
  path: `/workspace/${name}`,
  relativePath: name,
  size: 0,
});

describe('workspace sidebar sorting', () => {
  test('keeps directories first while preserving original filename casing', () => {
    const sorted = sortWorkspaceEntries([
      entry('package-lock.json', 'file', 1),
      entry('ZebraProject', 'directory', 2),
      entry('AlphaProject', 'directory', 3),
    ], 'name-asc');

    expect(sorted.map((item) => item.name)).toEqual(['AlphaProject', 'ZebraProject', 'package-lock.json']);
  });

  test('sorts by modified time within each entry type', () => {
    const sorted = sortWorkspaceEntries([
      entry('old-dir', 'directory', 1),
      entry('new-file.ts', 'file', 4),
      entry('new-dir', 'directory', 5),
      entry('old-file.ts', 'file', 2),
    ], 'modified-desc');

    expect(sorted.map((item) => item.name)).toEqual(['new-dir', 'old-dir', 'new-file.ts', 'old-file.ts']);
  });

  test('normalizes unknown sort modes to name ascending', () => {
    expect(normalizeWorkspaceSortMode('bad')).toBe('name-asc');
  });
});
