import { expect, test, vi } from 'vitest';
import type { ThreadIdentity } from '@varin/application-client';
import type { WorktreeMetadata } from '@/types/worktree';
import { createWorktreeThreadWithRuntime, type WorktreeThreadRuntime } from './worktreeThread';
const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:work', branchId: 'branch:main' };
const worktree = { branch: 'work', path: '/repo/.worktrees/work' } as WorktreeMetadata;
const makeRuntime = (override: Partial<WorktreeThreadRuntime> = {}): WorktreeThreadRuntime => ({
  checkIsGitRepository: async () => true,
  createThread: async () => identity,
  createWorktree: async () => worktree,
  generateBranchName: () => 'work',
  getActiveProject: () => ({ id: 'project', path: '/repo' }),
  shouldWaitForBootstrap: async () => false,
  waitForBootstrap: async () => {},
  ...override,
});
test('creates a native Thread with its real branch after configured workspace setup', async () => {
  const calls: string[] = [];
  const result = await createWorktreeThreadWithRuntime(makeRuntime({
    shouldWaitForBootstrap: async () => true,
    waitForBootstrap: async (path) => { calls.push(`wait:${path}`); },
    createThread: async (target) => { calls.push(`thread:${target.projectId}:${target.directory}`); return identity; },
  }));
  expect(calls).toEqual([`wait:${worktree.path}`, `thread:project:${worktree.path}`]);
  expect(result).toEqual({ branch: 'work', path: worktree.path, identity });
});
test('rejects non-Git navigation before any worktree mutation', async () => {
  const createWorktree = vi.fn();
  await expect(createWorktreeThreadWithRuntime(makeRuntime({ checkIsGitRepository: async () => false, createWorktree }))).rejects.toThrow('require a Git repository');
  expect(createWorktree).not.toHaveBeenCalled();
});
test('keeps the original worktree when native Thread acceptance is uncertain', async () => {
  await expect(createWorktreeThreadWithRuntime(makeRuntime({ createThread: async () => { throw new Error('reply lost'); } }))).rejects.toThrow(`Worktree retained at ${worktree.path}: reply lost`);
});
test('does not create a conversation when workspace setup fails', async () => {
  const createThread = vi.fn();
  await expect(createWorktreeThreadWithRuntime(makeRuntime({ shouldWaitForBootstrap: async () => true, waitForBootstrap: async () => { throw new Error('setup failed'); }, createThread }))).rejects.toThrow('setup failed');
  expect(createThread).not.toHaveBeenCalled();
});
