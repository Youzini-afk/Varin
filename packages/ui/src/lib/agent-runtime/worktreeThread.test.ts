import { expect, test, vi } from 'vitest';
import type { WorktreeMetadata } from '@/types/worktree';
import { createWorktreeThreadWithRuntime, type WorktreeThreadRuntime } from './worktreeThread';
const draftKey = 'draft:work';
const worktree = { branch: 'work', path: '/repo/.worktrees/work' } as WorktreeMetadata;
const makeRuntime = (override: Partial<WorktreeThreadRuntime> = {}): WorktreeThreadRuntime => ({
  checkIsGitRepository: async () => true,
  openDraft: async () => draftKey,
  createWorktree: async () => worktree,
  generateBranchName: () => 'work',
  getActiveProject: () => ({ id: 'project', path: '/repo' }),
  shouldWaitForBootstrap: async () => false,
  waitForBootstrap: async () => {},
  ...override,
});
test('opens a local draft after configured workspace setup', async () => {
  const calls: string[] = [];
  const result = await createWorktreeThreadWithRuntime(makeRuntime({
    shouldWaitForBootstrap: async () => true,
    waitForBootstrap: async (path) => { calls.push(`wait:${path}`); },
    openDraft: async (target) => { calls.push(`thread:${target.projectId}:${target.directory}`); return draftKey; },
  }));
  expect(calls).toEqual([`wait:${worktree.path}`, `thread:project:${worktree.path}`]);
  expect(result).toEqual({ branch: 'work', path: worktree.path, draftKey });
});
test('rejects non-Git navigation before any worktree mutation', async () => {
  const createWorktree = vi.fn();
  await expect(createWorktreeThreadWithRuntime(makeRuntime({ checkIsGitRepository: async () => false, createWorktree }))).rejects.toThrow('require a Git repository');
  expect(createWorktree).not.toHaveBeenCalled();
});
test('keeps the original worktree when opening the local draft fails', async () => {
  await expect(createWorktreeThreadWithRuntime(makeRuntime({ openDraft: async () => { throw new Error('reply lost'); } }))).rejects.toThrow(`Worktree retained at ${worktree.path}: reply lost`);
});
test('does not create a conversation when workspace setup fails', async () => {
  const openDraft = vi.fn();
  await expect(createWorktreeThreadWithRuntime(makeRuntime({ shouldWaitForBootstrap: async () => true, waitForBootstrap: async () => { throw new Error('setup failed'); }, openDraft }))).rejects.toThrow('setup failed');
  expect(openDraft).not.toHaveBeenCalled();
});

test('remote worktree creation carries original project owner through check, setup and draft', async () => {
  const source = { resourceOwner: { kind: 'managed_host' as const, hostId: 'remote', connectionId: 'remote-connection', endpointIdentity: 'remote-endpoint' }, workspaceId: 'root-documents' };
  const checkIsGitRepository = vi.fn(async () => true);
  const createWorktree = vi.fn(async () => worktree);
  const waitForBootstrap = vi.fn(async () => {});
  const openDraft = vi.fn(async () => draftKey);
  await createWorktreeThreadWithRuntime(makeRuntime({ getActiveProject: () => ({ id: 'remote-project', path: '/repo', source }), checkIsGitRepository, createWorktree, waitForBootstrap, openDraft, shouldWaitForBootstrap: async () => true }));
  const project = { id: 'remote-project', path: '/repo', source };
  expect(checkIsGitRepository).toHaveBeenCalledWith('/repo', project);
  expect(createWorktree).toHaveBeenCalledWith(project, 'work');
  expect(waitForBootstrap).toHaveBeenCalledWith(worktree.path, project);
  expect(openDraft).toHaveBeenCalledWith({ directory: worktree.path, projectId: 'remote-project', source });
});

test('a project owner change during discovery cannot redirect the later create', async () => {
  let project: import('@varin/application-client').ProjectEntry = { id: 'project', path: '/same' };
  const createWorktree = vi.fn();
  await expect(createWorktreeThreadWithRuntime(makeRuntime({ getActiveProject: () => project, createWorktree,
    checkIsGitRepository: async () => {
      project = { ...project, source: { resourceOwner: { kind: 'managed_host', hostId: 'replacement', connectionId: 'replacement', endpointIdentity: 'replacement' }, workspaceId: 'replacement-root' } };
      return true;
    },
  }))).rejects.toThrow('Project source or Application Host changed');
  expect(createWorktree).not.toHaveBeenCalled();
});
