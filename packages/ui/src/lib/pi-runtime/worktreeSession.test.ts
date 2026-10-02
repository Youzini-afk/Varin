import { describe, expect, test } from 'bun:test';
import type { SessionSnapshot } from '@varin/protocol';
import type { WorktreeMetadata } from '@/types/worktree';
import {
  createPiWorktreeSessionWithRuntime,
  type PiWorktreeSessionRuntime,
} from './worktreeSession';

const worktree: WorktreeMetadata = {
  branch: 'varin-work',
  headState: 'branch',
  label: 'varin-work',
  name: 'varin-work',
  path: 'D:/repo/.worktrees/varin-work',
  projectDirectory: 'D:/repo',
  source: 'sdk',
  worktreeRoot: 'D:/repo/.worktrees/varin-work',
  worktreeSource: 'created-for-session',
  worktreeStatus: 'ready',
};

const session: SessionSnapshot = {
  activeTools: [],
  busy: false,
  cwd: worktree.path,
  features: { revision: 0, schemaVersion: 1 },
  followUp: [],
  followUpMode: 'all',
  queuedMessages: [],
  isCompacting: false,
  isStreaming: false,
  leafId: null,
  pendingMessageCount: 0,
  retryAttempt: 0,
  sessionId: 'pi-session',
  steering: [],
  steeringMode: 'all',
  thinkingLevel: 'off',
};

const runtime = (
  overrides: Partial<PiWorktreeSessionRuntime> = {},
): PiWorktreeSessionRuntime => ({
  checkIsGitRepository: async () => true,
  createSession: async () => session,
  createWorktree: async () => worktree,
  generateBranchName: () => 'varin-work',
  getActiveProject: () => ({ id: 'project', path: 'D:/repo' }),
  removeWorktree: async () => undefined,
  shouldWaitForBootstrap: async () => false,
  waitForBootstrap: async () => undefined,
  ...overrides,
});

describe('Pi worktree session orchestration', () => {
  test('creates the worktree and a Pi session in its directory', async () => {
    const calls: string[] = [];
    const result = await createPiWorktreeSessionWithRuntime(runtime({
      createWorktree: async (project, name) => {
        calls.push(`worktree:${project.id}:${name}`);
        return worktree;
      },
      createSession: async (target) => {
        calls.push(`session:${target.projectId}:${target.directory}`);
        return session;
      },
    }));

    expect(result).toEqual({
      branch: 'varin-work',
      path: worktree.path,
      sessionId: 'pi-session',
    });
    expect(calls).toEqual([
      'worktree:project:varin-work',
      `session:project:${worktree.path}`,
    ]);
  });

  test('honors the configured bootstrap wait before creating the session', async () => {
    const calls: string[] = [];
    await createPiWorktreeSessionWithRuntime(runtime({
      shouldWaitForBootstrap: async () => true,
      waitForBootstrap: async (path) => { calls.push(`wait:${path}`); },
      createSession: async () => {
        calls.push('session');
        return session;
      },
    }));
    expect(calls).toEqual([`wait:${worktree.path}`, 'session']);
  });

  test('rejects non-Git projects before creating anything', async () => {
    let created = false;
    const action = createPiWorktreeSessionWithRuntime(runtime({
      checkIsGitRepository: async () => false,
      createWorktree: async () => {
        created = true;
        return worktree;
      },
    }));
    await expect(action).rejects.toThrow('require a Git repository');
    expect(created).toBe(false);
  });

  test('removes a newly-created worktree when Pi session creation fails', async () => {
    const removed: string[] = [];
    const action = createPiWorktreeSessionWithRuntime(runtime({
      createSession: async () => { throw new Error('runtime unavailable'); },
      removeWorktree: async (_project, created) => { removed.push(created.path); },
    }));
    await expect(action).rejects.toThrow('runtime unavailable');
    expect(removed).toEqual([worktree.path]);
  });

  test('reports both session and cleanup failures', async () => {
    const action = createPiWorktreeSessionWithRuntime(runtime({
      createSession: async () => { throw new Error('session failed'); },
      removeWorktree: async () => { throw new Error('cleanup failed'); },
    }));
    await expect(action).rejects.toThrow('session failed');
    await expect(action).rejects.toThrow('cleanup failed');
  });
});
