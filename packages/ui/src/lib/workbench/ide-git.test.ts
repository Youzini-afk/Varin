import { projectGitAddress } from '@varin/application-client';
import { describe, expect, test } from 'vitest';
import {
  gitRepositoryRootWithinWorkspace,
  resolveIdeGitResourceId,
} from './ide-git';

describe('IDE Git repository scope', () => {
  test('maps repository-relative paths through a nested repository root', () => {
    expect(resolveIdeGitResourceId(
      '/home/varin/workspaces',
      '/home/varin/workspaces/product/packages/app',
      'src/main.ts',
    )).toBe('product/packages/app/src/main.ts');
  });

  test('maps Windows paths case-insensitively without losing their display spelling', () => {
    expect(resolveIdeGitResourceId(
      'D:\\Workspaces',
      'd:\\workspaces\\Product',
      'src\\main.ts',
    )).toBe('Product/src/main.ts');
  });

  test('rejects repository roots outside the active workspace', () => {
    expect(gitRepositoryRootWithinWorkspace('/workspace/product', '/workspace/other')).toBeNull();
    expect(resolveIdeGitResourceId('/workspace/product', '/workspace/other', 'src/main.ts')).toBeNull();
  });

  test('rejects absolute and traversing Git paths', () => {
    expect(resolveIdeGitResourceId('/workspace', '/workspace/repo', '../secret.ts')).toBeNull();
    expect(resolveIdeGitResourceId('/workspace', '/workspace/repo', '/etc/passwd')).toBeNull();
    expect(resolveIdeGitResourceId('/workspace', '/workspace/repo', 'C:\\secret.ts')).toBeNull();
  });
});

test('keeps remote nested Git roots in their exact source while mapping editor resource paths', () => {
  const address = (hostId: string, path: string) => projectGitAddress({ projectId: 'project', source: { workspaceId: 'documents', resourceOwner: { kind: 'managed_host', hostId, connectionId: hostId, endpointIdentity: `https://${hostId}.example` } }, selection: { mode: 'live_root' }, path });
  const root = address('a', '/same'), nested = address('a', '/same/nested');
  expect(gitRepositoryRootWithinWorkspace(root, nested)).toBe(nested);
  expect(resolveIdeGitResourceId(root, nested, 'src/file.ts')).toBe('nested/src/file.ts');
  expect(gitRepositoryRootWithinWorkspace(root, address('b', '/same/nested'))).toBeNull();
  expect(gitRepositoryRootWithinWorkspace(root, '/same/nested')).toBeNull();
  expect(gitRepositoryRootWithinWorkspace('/same', nested)).toBeNull();
});
