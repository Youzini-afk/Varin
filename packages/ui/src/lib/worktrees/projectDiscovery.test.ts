import { expect, test, vi } from 'vitest';
import type { GitHubAPI } from '@varin/application-client';
const fixtures = vi.hoisted(() => ({ management: vi.fn(), resolve: vi.fn(), host: 1 }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), manageProject: fixtures.management, getRuntimeEndpointGeneration: () => fixtures.host }));
vi.mock('@/lib/projectSource', () => ({ resolveProjectSource: fixtures.resolve }));
import { projectGitHubReads, worktreeDraftSource } from './projectDiscovery';
const owner = { kind: 'managed_host' as const, hostId: 'source-host', connectionId: 'source-connection', endpointIdentity: 'source-endpoint' };
const project = { id: 'project', path: '/same', source: { resourceOwner: owner, workspaceId: 'parent-root' } };

test('remote GitHub discovery binds project source and never invokes the local GitHub API', async () => {
  fixtures.management.mockResolvedValue({ connected: true, issues: [] });
  const issuesList = vi.fn();
  const github = projectGitHubReads(project, { issuesList } as unknown as GitHubAPI)!;
  await github.issuesList('/ignored-caller-directory', { page: 2, query: 'is:open' });
  expect(fixtures.management).toHaveBeenLastCalledWith('project', 'github-issues', { page: 2, query: 'is:open' }, undefined, project.source);
  expect(issuesList).not.toHaveBeenCalled();
});

test('new worktree draft freezes target live-root registration, not parent Documents identity', async () => {
  fixtures.resolve.mockResolvedValue({ resourceOwner: owner, path: '/same.worktrees/new', workspaceId: 'new-documents-root' });
  expect(await worktreeDraftSource(project, '/same.worktrees/new')).toEqual({ resourceOwner: owner, path: '/same.worktrees/new', expectedWorkspaceId: 'new-documents-root', mode: 'live_root', selection: { mode: 'live_root' }, contentMode: 'saved-files', captureScopes: [] });
  expect(fixtures.resolve).toHaveBeenLastCalledWith(owner, '/same.worktrees/new');
});

test('changing coordinator during discovery cannot deliver a stale project result', async () => {
  fixtures.management.mockImplementationOnce(async () => { fixtures.host += 1; return { connected: true }; });
  const github = projectGitHubReads(project, null)!;
  await expect(github.authStatus()).rejects.toThrow('Application Host changed');
});
