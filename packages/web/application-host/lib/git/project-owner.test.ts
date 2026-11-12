import path from 'node:path';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import { beforeEach, expect, test, vi } from 'vitest';
import type { ManagedSourcePrincipal } from '../harness/managed-remote-types.js';
const f = vi.hoisted(() => ({ allowed: vi.fn(), primary: vi.fn() }));
vi.mock('../workspace/resource-access.js', () => ({ assertResourcePathAllowed: f.allowed }));
vi.mock('./index.js', () => ({ resolvePrimaryWorktreeRoot: f.primary }));
import { dispatchProjectGit, dispatchProjectGitHub } from './project-owner.js';
const principal: ManagedSourcePrincipal = { principalId: 'paired', capabilities: ['filesystem:read', 'filesystem:write', 'terminal:use', 'process:control'], allowedDirectories: ['/target'] };
beforeEach(() => { vi.clearAllMocks(); f.primary.mockImplementation(async (path: string) => ({ root: path })); });
test('native project Git resolves original logical adoption before original Git writer', async () => {
  const dispatch = vi.fn(), prepareSelection = vi.fn(async () => ({ path: path.resolve('/execution/view') }));
  const selection = { mode: 'native_workspace' as const, workspaceId: 'root', executionWorkspaceId: 'execution', branchId: 'branch', adoptionOperationId: 'adopt' };
  await dispatchProjectGit({ dispatch, nativeWorkspaces: { prepareSelection } as never }, principal, 'root', '/target/repo', { operation: 'stageGitFiles', args: ['/target/repo', ['file']], selection });
  expect(prepareSelection).toHaveBeenCalledWith(selection, 'project-git:paired:root', undefined);
  expect(dispatch).toHaveBeenCalledWith({ operation: 'stageGitFiles', args: [path.resolve('/execution/view'), ['file']], selection }, undefined);
});
test('file mutation permission does not imply credential management permission', async () => {
  const dispatch = vi.fn();
  await expect(dispatchProjectGit({ dispatch }, principal, 'root', '/target/repo', { operation: 'deleteGitIdentity', args: ['identity'], selection: { mode: 'live_root' } })).rejects.toThrow('config:write');
  await expect(dispatchProjectGitHub({ dispatch }, principal, 'root', '/target/repo', { operation: 'authActivate', args: ['identity'], selection: { mode: 'live_root' } })).rejects.toThrow('config:read');
  expect(dispatch).not.toHaveBeenCalled();
});
test('cannot send another repository directory to original writer', async () => {
  const dispatch = vi.fn();
  await expect(dispatchProjectGit({ dispatch }, principal, 'root', '/target/repo', { operation: 'getGitStatus', args: ['/target/other'], selection: { mode: 'live_root' } })).rejects.toThrow('another project');
  expect(dispatch).not.toHaveBeenCalled();
});
test('GitHub PR mutation reuses target directory and original credential owner', async () => {
  const dispatch = vi.fn();
  const command = { operation: 'prMerge' as const, args: [{ directory: '/target/repo', number: 1, method: 'squash' as const }], selection: { mode: 'live_root' as const } };
  await dispatchProjectGitHub({ dispatch }, principal, 'root', '/target/repo', command as never);
  expect(dispatch).toHaveBeenCalledWith({ ...command, args: [{ ...command.args[0], directory: path.resolve('/target/repo') }] }, undefined);
});

test('adopted nested Git discovery returns the original logical root without granting the mount', async () => {
  const logical = path.resolve('/target/repo'), execution = path.resolve('/execution/view');
  const selection = { mode: 'native_workspace' as const, workspaceId: 'root', executionWorkspaceId: 'execution', branchId: 'branch', adoptionOperationId: 'adopt' };
  const prepareSelection = vi.fn(async () => ({ path: execution }));
  // A directory within a nested repository resolves upward within the same
  // originally owned mount, not through the user's physical path allowlist.
  f.primary.mockResolvedValue({ root: execution });
  const dispatch = vi.fn(async () => ({ root: path.join(execution, 'nested') }));
  const result = await dispatchProjectGit({ dispatch, nativeWorkspaces: { prepareSelection } as never }, principal, 'root', logical,
    { operation: 'resolveGitTopLevel', args: [path.join(logical, 'nested', 'src')], selection });
  expect(dispatch).toHaveBeenCalledWith({ operation: 'resolveGitTopLevel', args: [path.join(execution, 'nested', 'src')], selection }, undefined);
  expect(result).toEqual({ root: path.join(logical, 'nested') });
  expect(f.allowed.mock.calls).toEqual([[logical, principal.allowedDirectories]]);
});

test('an original directory alias maps into the adoption while a foreign real directory is refused', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'project-git-owner-'));
  try {
    const root = path.join(temporary, 'original'), alias = path.join(temporary, 'alias'), foreign = path.join(temporary, 'foreign');
    await Promise.all([mkdir(root), mkdir(foreign)]);
    await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const execution = path.join(temporary, 'execution');
    const prepareSelection = vi.fn(async () => ({ path: execution })), dispatch = vi.fn();
    const selection = { mode: 'native_workspace' as const, workspaceId: 'root', executionWorkspaceId: 'execution', branchId: 'branch', adoptionOperationId: 'adopt' };
    const options = { dispatch, nativeWorkspaces: { prepareSelection } as never };
    await dispatchProjectGit(options, principal, 'root', root, { operation: 'getGitStatus', args: [alias], selection });
    expect(dispatch).toHaveBeenCalledWith({ operation: 'getGitStatus', args: [execution], selection }, undefined);
    await expect(dispatchProjectGit(options, principal, 'root', root, { operation: 'getGitStatus', args: [foreign], selection })).rejects.toThrow('original adopted project');
    expect(dispatch).toHaveBeenCalledTimes(1);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
