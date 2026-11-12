import { executeProjectGit, executeProjectGitHub } from '@varin/application-client';
import { expect, it, vi } from 'vitest';
import type { ProjectEntry, VersionedProjectWorkspace } from '@varin/application-client';
import type { ManagedProjectManagementRequest } from './managed-project-management.js';
import { registerProjectManagementRoutes } from './project-management-routes.js';

it('persists the original target adoption intent before effects, and retries the same identity after a lost response', async () => {
  let handler: (request: unknown, response: unknown) => Promise<void> = async () => {};
  let project = { id: 'project', path: 'C:\\target\\repo', source: { workspaceId: 'original-workspace', resourceOwner: { kind: 'managed_host', hostId: 'target', connectionId: 'connection', endpointIdentity: 'endpoint' } } } as import('@varin/application-client').ProjectEntry;
  const planned = { workspaceId: 'original-workspace', executionWorkspaceId: 'target-view', branchId: 'target-branch', adoptionOperationId: 'original-adoption', state: 'preparing' as const };
  const update = vi.fn(async (_expected: ProjectEntry, workspace: VersionedProjectWorkspace) => { project = { ...project, versionedWorkspace: workspace }; });
  let loseReply = true;
  const remote = { projectManagement: vi.fn(async (input: ManagedProjectManagementRequest) => {
    if (input.command.action === 'workspace-plan') return planned;
    expect(project.versionedWorkspace).toEqual(planned);
    expect(input.workspace).toEqual(planned);
    expect(input).not.toHaveProperty('path');
    if (loseReply) { loseReply = false; throw new Error('Reply lost after target accepted'); }
    return { workspace: { ...planned, state: 'ready' }, preparing: false };
  }) };
  registerProjectManagementRoutes({ post: (_path: string, _auth: unknown, fn: typeof handler) => { handler = fn; } } as never, {
    requireAuth: vi.fn(), authorize: async () => true, coordinatorHostId: 'coordinator', projects: async () => [project],
    update, remote: async () => remote as never,
  });
  const response = () => ({ writableEnded: false, destroyed: false, once: vi.fn(), removeListener: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() });
  const request = { params: { projectId: 'project' }, body: { action: 'enable', input: {} } };
  const failed = response(); await handler(request, failed);
  expect(failed.status).toHaveBeenCalledWith(409); expect(project.versionedWorkspace).toEqual(planned);
  const retried = response(); await handler(request, retried);
  expect(remote.projectManagement.mock.calls.filter(([input]) => input.command.action === 'workspace-plan')).toHaveLength(1);
  expect(update).toHaveBeenCalledTimes(2);
  expect(project.versionedWorkspace?.state).toBe('ready');
});

it('rejects the authenticated nonowner before project lookup or remote resource access', async () => {
  let handler: (request: unknown, response: unknown) => Promise<void> = async () => {};
  const projects = vi.fn(), remote = vi.fn();
  const authorize = vi.fn(async (request: unknown) => {
    expect(request).toMatchObject({ authenticatedPrincipal: 'nonowner' }); return false;
  });
  registerProjectManagementRoutes({ post: (_path: string, _auth: unknown, fn: typeof handler) => { handler = fn; } } as never, {
    requireAuth: vi.fn(), authorize, coordinatorHostId: 'coordinator', projects, remote, update: vi.fn(),
  });
  const response = { writableEnded: false, destroyed: false, once: vi.fn(), removeListener: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
  await handler({ authenticatedPrincipal: 'nonowner', params: { projectId: 'project' }, body: { action: 'worktrees', input: {} } }, response);
  expect(response.status).toHaveBeenCalledWith(403); expect(projects).not.toHaveBeenCalled(); expect(remote).not.toHaveBeenCalled();
});

it('does not redirect a frozen remote observation to a newly rebound project', async () => {
  let handler: (request: unknown, response: unknown) => Promise<void> = async () => {};
  const source = { workspaceId: 'new-workspace', resourceOwner: { kind: 'managed_host' as const, hostId: 'new-host', connectionId: 'new-connection', endpointIdentity: 'new-endpoint' } };
  const remote = vi.fn();
  registerProjectManagementRoutes({ post: (_path: string, _auth: unknown, fn: typeof handler) => { handler = fn; } } as never, {
    requireAuth: vi.fn(), authorize: async () => true, coordinatorHostId: 'coordinator',
    projects: async () => [{ id: 'project', path: '/same/path', source } as ProjectEntry], remote, update: vi.fn(),
  });
  const response = { writableEnded: false, destroyed: false, once: vi.fn(), removeListener: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
  await handler({ params: { projectId: 'project' }, body: { action: 'worktrees', input: {}, expectedSource: { ...source, workspaceId: 'old-workspace' } } }, response);
  expect(response.status).toHaveBeenCalledWith(409); expect(remote).not.toHaveBeenCalled();
});


it.each(['git-command', 'github-command'] as const)('delivers %s void, null and primitive results through the coordinator HTTP client', async action => {
  let handler: (request: unknown, response: unknown) => Promise<void> = async () => {};
  const source = { workspaceId: 'workspace', resourceOwner: { kind: 'managed_host' as const, hostId: 'target', connectionId: 'connection', endpointIdentity: 'endpoint' } };
  let value: unknown;
  const remote = { projectManagement: vi.fn(async () => value) };
  registerProjectManagementRoutes({ post: (_path: string, _auth: unknown, fn: typeof handler) => { handler = fn; } } as never, {
    requireAuth: vi.fn(), authorize: async () => true, coordinatorHostId: 'coordinator', projects: async () => [{ id: 'project', path: '/target', source } as ProjectEntry],
    remote: async () => remote as never, update: vi.fn(),
  });
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    let status = 200, body: unknown;
    const response = { writableEnded: false, destroyed: false, once: vi.fn(), removeListener: vi.fn(),
      status(code: number) { status = code; return response; }, json(result: unknown) { body = result; return response; } };
    await handler({ params: { projectId: 'project' }, body: JSON.parse(String(init?.body)) }, response);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  try {
    for (const expected of [undefined, null, false, 0, '', 'original', [], ['entry'], { original: true }]) {
      value = expected;
      const result = action === 'git-command'
        ? await executeProjectGit('project', source, { mode: 'live_root' }, 'stageGitFile', ['/target', 'file'])
        : await executeProjectGitHub('project', source, { mode: 'live_root' }, 'prStatus', ['/target', 'main']);
      expect(result).toEqual(expected);
    }
    expect(remote.projectManagement).toHaveBeenCalledTimes(9);
  } finally { fetch.mockRestore(); }
});
