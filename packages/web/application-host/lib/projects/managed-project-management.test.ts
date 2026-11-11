import { expect, it, vi, beforeEach } from 'vitest';
import { createManagedProjectManagementOwner } from './managed-project-management.js';
import type { ManagedProjectManagementRequest } from './managed-project-management.js';
import type { ManagedSourcePrincipal } from '../harness/managed-remote-types.js';
const mocks = vi.hoisted(() => ({ allowed: vi.fn(async () => undefined), worktrees: vi.fn(async () => [{ path: '/target/repo', name: 'repo', head: 'head', branch: 'main' }]),
  create: vi.fn(async () => ({ path: '/target/new', name: 'new', branch: 'new', head: 'head' })), native: vi.fn(), primary: vi.fn(async () => ({ root: '/target/repo' })) }));
vi.mock('../workspace/resource-access.js', () => ({ assertResourcePathAllowed: mocks.allowed }));
vi.mock('../git/index.js', () => ({ getWorktrees: mocks.worktrees, createWorktree: mocks.create, resolvePrimaryWorktreeRoot: mocks.primary }));
vi.mock('../kernel/native-workspaces.js', () => ({ createNativeWorkspaceOwner: mocks.native }));
const principal: ManagedSourcePrincipal = { principalId: 'paired', capabilities: ['filesystem:read','filesystem:write','terminal:use','process:control'], allowedDirectories: ['/target'] };
const request: ManagedProjectManagementRequest = { coordinatorHostId: 'coordinator', projectId: 'project', workspaceId: 'workspace', command: { action: 'worktrees', input: {} } };
beforeEach(() => { vi.clearAllMocks(); mocks.native.mockImplementation(() => ({})); });
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
