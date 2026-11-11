import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceRegistry } from '../documents/workspace-registry.js';
import type { VersionedProjectWorkspace } from '@varin/application-client';
import { expect, it, vi, beforeEach } from 'vitest';
import { createManagedProjectManagementOwner } from './managed-project-management.js';
import type { ManagedProjectManagementRequest } from './managed-project-management.js';
import type { ManagedSourcePrincipal } from '../harness/managed-remote-types.js';
const mocks = vi.hoisted(() => ({ allowed: vi.fn(async () => undefined), worktrees: vi.fn(async () => [{ path: '/target/repo', name: 'repo', head: 'head', branch: 'main' }]),
  create: vi.fn(async () => ({ path: '/target/new', name: 'new', branch: 'new', head: 'head' })), primary: vi.fn(async () => ({ root: '/target/repo' })) }));
vi.mock('../workspace/resource-access.js', () => ({ assertResourcePathAllowed: mocks.allowed }));
vi.mock('../git/index.js', () => ({ getWorktrees: mocks.worktrees, createWorktree: mocks.create, resolvePrimaryWorktreeRoot: mocks.primary }));
const principal: ManagedSourcePrincipal = { principalId: 'paired', capabilities: ['filesystem:read','filesystem:write','terminal:use','process:control'], allowedDirectories: ['/target'] };
const request: ManagedProjectManagementRequest = { coordinatorHostId: 'coordinator', projectId: 'project', workspaceId: 'workspace', command: { action: 'worktrees', input: {} } };
beforeEach(() => { vi.clearAllMocks(); });
function fixture() {
  const documents = { admitWorkspaceRegistration: vi.fn(async () => ({ canonicalPath: '/target/repo' })) };
  return { documents, manage: createManagedProjectManagementOwner({ documents, kernel: {} } as never) };
}
it('uses the original target registration and strict Git reader, without coordinator paths', async () => {
  const f = fixture();
  await expect(f.manage(principal, request)).resolves.toHaveLength(1);
  expect(f.documents.admitWorkspaceRegistration).toHaveBeenCalledWith('workspace', undefined);
  expect(mocks.worktrees).toHaveBeenCalledWith('/target/repo', { strict: true });
  expect(mocks.allowed).toHaveBeenCalledWith('/target/repo', ['/target']);
});
it('propagates target offline failures instead of returning an empty worktree list', async () => {
  mocks.worktrees.mockRejectedValueOnce(new Error('target disconnected'));
  await expect(fixture().manage(principal, request)).rejects.toThrow('target disconnected');
});
it('validates mutation permission before calling original Git writer', async () => {
  await expect(fixture().manage({ ...principal, capabilities: ['filesystem:read'] }, { ...request, command: { action: 'worktree-create', input: {} } })).rejects.toThrow('write access');
  expect(mocks.create).not.toHaveBeenCalled();
});
it('freezes adoption in the authenticated coordinator/project/workspace namespace', async () => {
  const f = fixture(), input = { ...request, command: { action: 'workspace-plan' as const, input: {} } };
  const first = await f.manage(principal, input);
  expect(await f.manage(principal, input)).toEqual(first);
  expect(await f.manage({ ...principal, principalId: 'another' }, input)).not.toEqual(first);
  await expect(f.manage(principal, { ...request, workspace: { ...(first as object), branchId: 'foreign' } as never, command: { action: 'enable', input: {} } })).rejects.toThrow('identity changed');
});

it('registers the planned native identity in the original Documents registry and preserves it after reopen', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-project-identity-'));
  try {
    const options = { hostId: 'target', filePath: path.join(directory, 'registry.json'), fsPromises: fs };
    const registry = createWorkspaceRegistry(options);
    const physical = (await registry.resolve({ canonicalPath: directory, create: true }))!;
    const input = { ...request, workspaceId: physical.workspaceId, command: { action: 'workspace-plan' as const, input: {} } };
    const planned = await fixture().manage(principal, input) as VersionedProjectWorkspace;
    const reference = { workspace_id: planned.workspaceId, execution_workspace_id: planned.executionWorkspaceId, branch_id: planned.branchId };
    const registered = await registry.registerNative(planned.executionWorkspaceId, directory, reference);
    expect(registered.nativeSource).toEqual(reference);
    expect(await createWorkspaceRegistry(options).get(planned.executionWorkspaceId)).toEqual(registered);
    expect(await fixture().manage(principal, input)).toEqual(planned);
    for (const other of [{ ...input, projectId: 'other' }, { ...input, coordinatorHostId: 'other' }]) {
      expect((await fixture().manage(principal, other) as VersionedProjectWorkspace).executionWorkspaceId).not.toBe(planned.executionWorkspaceId);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

it('rejects an earlier noncanonical adoption plan without remapping or replaying its original receipt', async () => {
  const projectLifecycle = vi.fn(() => ({ enable: vi.fn() }));
  const manage = createManagedProjectManagementOwner({ kernel: {},
    documents: { admitWorkspaceRegistration: async () => ({ canonicalPath: '/target/repo' }) },
    nativeWorkspaces: { projectLifecycle } } as never);
  const planned = await manage(principal, { ...request, command: { action: 'workspace-plan', input: {} } }) as VersionedProjectWorkspace;
  const earlier = { ...planned, executionWorkspaceId: `managed-project:${planned.branchId.slice('project-workspace:'.length)}`, state: 'ready' as const };
  const saved = structuredClone(earlier);
  for (const action of ['enable', 'disable', 'inspect'] as const) {
    await expect(manage(principal, { ...request, workspace: earlier, command: { action, input: {} } })).rejects.toThrow('Original project adoption identity changed');
  }
  expect(earlier).toEqual(saved);
  expect(projectLifecycle).not.toHaveBeenCalled();
});
