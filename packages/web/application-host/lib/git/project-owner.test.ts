import { beforeEach, expect, test, vi } from 'vitest';
import type { ManagedSourcePrincipal } from '../harness/managed-remote-types.js';
const f = vi.hoisted(() => ({ allowed: vi.fn(), primary: vi.fn() }));
vi.mock('../workspace/resource-access.js', () => ({ assertResourcePathAllowed: f.allowed }));
vi.mock('./index.js', () => ({ resolvePrimaryWorktreeRoot: f.primary }));
import { dispatchProjectGit, dispatchProjectGitHub } from './project-owner.js';
const principal: ManagedSourcePrincipal = { principalId: 'paired', capabilities: ['filesystem:read', 'filesystem:write', 'terminal:use', 'process:control'], allowedDirectories: ['/target'] };
beforeEach(() => { vi.clearAllMocks(); f.primary.mockImplementation(async (path: string) => ({ root: path })); });
test('native project Git resolves original logical adoption before original Git writer', async () => {
  const dispatch = vi.fn(), prepareSelection = vi.fn(async () => ({ path: '/execution/view' }));
  const selection = { mode: 'native_workspace' as const, workspaceId: 'root', executionWorkspaceId: 'execution', branchId: 'branch', adoptionOperationId: 'adopt' };
  await dispatchProjectGit({ dispatch, nativeWorkspaces: { prepareSelection } as never }, principal, 'root', '/target/repo', { operation: 'stageGitFiles', args: ['/target/repo', ['file']], selection });
  expect(prepareSelection).toHaveBeenCalledWith(selection, 'project-git:paired:root', undefined);
  expect(dispatch).toHaveBeenCalledWith({ operation: 'stageGitFiles', args: ['/execution/view', ['file']], selection }, undefined);
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
  expect(dispatch).toHaveBeenCalledWith(command, undefined);
});
