import { describe, expect, test } from 'vitest';

import {
  getDefaultArchiveDestination,
  getWorkspaceArchiveBaseName,
  isWorkspaceArchivePath,
} from './workspaceArchive';

describe('workspaceArchive helpers', () => {
  test('detects supported archive extensions case-insensitively', () => {
    expect(isWorkspaceArchivePath('demo.zip')).toBe(true);
    expect(isWorkspaceArchivePath('demo.TAR')).toBe(true);
    expect(isWorkspaceArchivePath('demo.tar.gz')).toBe(true);
    expect(isWorkspaceArchivePath('demo.TGZ')).toBe(true);
    expect(isWorkspaceArchivePath('demo.rar')).toBe(false);
  });

  test('derives archive base names and default destinations', () => {
    expect(getWorkspaceArchiveBaseName('project/demo.tar.gz')).toBe('demo');
    expect(getDefaultArchiveDestination('project/demo.tar.gz', 'new-folder')).toBe('project/demo');
    expect(getDefaultArchiveDestination('project/demo.tar.gz', 'merge')).toBe('project');
    expect(getDefaultArchiveDestination('demo.zip', 'merge')).toBe('');
  });
});
