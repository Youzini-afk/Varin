import path from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ManagedSourcePrincipal } from '../harness/managed-remote-types.js';

const f = vi.hoisted(() => ({
  platform: 'win32',
  allowed: vi.fn(async () => undefined),
  create: vi.fn(), list: vi.fn(), bootstrap: vi.fn(), remove: vi.fn(),
}));
vi.mock('../workspace/resource-access.js', () => ({ assertResourcePathAllowed: f.allowed }));
vi.mock('../git/index.js', () => ({
  resolvePrimaryWorktreeRoot: async (root: string) => ({ root }),
  createWorktree: f.create, getWorktrees: f.list, getWorktreeBootstrapStatus: f.bootstrap, removeWorktree: f.remove,
}));
// Run the actual path identity algorithms with target Windows semantics on any
// test host. Only filesystem resolution and the Git owner boundary are fixtures.
vi.mock('../workspace/path-safety.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../workspace/path-safety.js')>();
  return {
    ...actual,
    canonicalizePathIdentity: (value: string, options: object) => actual.canonicalizePathIdentity(value, {
      ...options, pathModule: f.platform === 'win32' ? path.win32 : path.posix, fsPromises: { realpath: async target => target },
    }),
    normalizePathIdentity: (value: string) => actual.normalizePathIdentity(value, { pathModule: f.platform === 'win32' ? path.win32 : path.posix, platform: f.platform }),
  };
});
import { createManagedProjectManagementOwner } from './managed-project-management.js';

const principal: ManagedSourcePrincipal = { principalId: 'paired', capabilities: ['filesystem:read', 'filesystem:write', 'terminal:use'], allowedDirectories: ['C:\\Target'] };
const base = { coordinatorHostId: 'coordinator', projectId: 'project', workspaceId: 'workspace' };
beforeEach(() => { vi.resetAllMocks(); f.platform = 'win32'; });

it.each(['C:\\Target\\Worktrees\\Created', '\\\\server\\share\\Worktrees\\Created'])(
  'observes and removes the original Git worktree across Windows path representations: %s', async directory => {
    const repository = 'C:\\Target\\Repository';
    const documents = { admitWorkspaceRegistration: async () => ({ canonicalPath: repository }) };
    const manage = createManagedProjectManagementOwner({ documents, kernel: {} } as never);
    const listed = directory.replace(/\\/g, '/');
    const created = { path: directory, name: 'Created', branch: 'created', head: 'head' };
    f.create.mockResolvedValue(created);
    f.list.mockResolvedValue([{ ...created, path: listed }]);
    f.remove.mockResolvedValue(true);
    expect(await manage(principal, { ...base, command: { action: 'worktree-create', input: { worktreeName: 'Created' } } })).toBe(created);
    const aliases = [created.path, listed.toLowerCase(), path.win32.toNamespacedPath(created.path)];
    for (const status of ['pending', 'failed'] as const) {
      const receipt = { status, phase: 'directory-created', updatedAt: 42, error: status === 'failed' ? 'original setup failure' : null };
      f.bootstrap.mockResolvedValue(receipt);
      for (const alias of aliases) {
        expect(await manage(principal, { ...base, command: { action: 'worktree-bootstrap', input: { directory: alias } } })).toBe(receipt);
        expect(f.bootstrap).toHaveBeenLastCalledWith(listed);
      }
    }
    await expect(manage(principal, { ...base, command: { action: 'worktree-remove', input: { directory: created.path, deleteLocalBranch: true } } })).resolves.toEqual({ success: true });
    expect(f.remove).toHaveBeenCalledWith(repository, { directory: listed, deleteLocalBranch: true }, expect.objectContaining({ documents }));
    expect(f.create).toHaveBeenCalledTimes(1);
    for (const action of ['worktree-bootstrap', 'worktree-remove'] as const) {
      await expect(manage(principal, { ...base, command: { action, input: { directory: directory.replace('Worktrees', 'ForeignRepository') } } })).rejects.toThrow('not registered');
    }
    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(f.bootstrap).toHaveBeenCalledTimes(6);
  },
);

it('does not fold distinct POSIX directory names when admitting a worktree', async () => {
  f.platform = 'linux';
  const documents = { admitWorkspaceRegistration: async () => ({ canonicalPath: '/target/repository' }) };
  const manage = createManagedProjectManagementOwner({ documents, kernel: {} } as never);
  f.list.mockResolvedValue([{ path: '/target/Created', name: 'Created', branch: 'created', head: 'head' }]);
  for (const action of ['worktree-bootstrap', 'worktree-remove'] as const) {
    await expect(manage(principal, { ...base, command: { action, input: { directory: '/target/created' } } })).rejects.toThrow('not registered');
  }
  expect(f.bootstrap).not.toHaveBeenCalled();
  expect(f.remove).not.toHaveBeenCalled();
});
