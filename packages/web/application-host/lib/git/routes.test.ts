import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
interface WriterRecord {
  close: ReturnType<typeof vi.fn>;
  markMutated: ReturnType<typeof vi.fn>;
}

const gitLibraries = {
  cloneRepository: vi.fn(),
  getProfile: vi.fn(),
  getGlobalIdentity: vi.fn(),
  getStatus: vi.fn(),
  isGitRepository: vi.fn(),
  stageFiles: vi.fn(),
  unstageFiles: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  getWorktrees: vi.fn(),
  integrateWorktreeCommits: vi.fn(),
};

vi.mock('./index.js', () => ({
  cloneRepository: gitLibraries.cloneRepository,
  getProfile: gitLibraries.getProfile,
  getGlobalIdentity: gitLibraries.getGlobalIdentity,
  getStatus: gitLibraries.getStatus,
  isGitRepository: gitLibraries.isGitRepository,
  stageFiles: gitLibraries.stageFiles,
  unstageFiles: gitLibraries.unstageFiles,
  createWorktree: gitLibraries.createWorktree,
  removeWorktree: gitLibraries.removeWorktree,
  getWorktrees: gitLibraries.getWorktrees,
  integrateWorktreeCommits: gitLibraries.integrateWorktreeCommits,
}));

const { registerGitRoutes } = await import('./routes.js');

const createGitApp = (options: Parameters<typeof registerGitRoutes>[1] = {}) => {
  const app = express();
  app.use(express.json());
  registerGitRoutes(app, options);
  return app;
};

describe('git routes index mutations', () => {
  beforeEach(() => {
    gitLibraries.cloneRepository.mockReset();
    gitLibraries.getProfile.mockReset();
    gitLibraries.getGlobalIdentity.mockReset();
    gitLibraries.getStatus.mockReset();
    gitLibraries.isGitRepository.mockReset();
    gitLibraries.stageFiles.mockReset();
    gitLibraries.unstageFiles.mockReset();
    gitLibraries.createWorktree.mockReset();
    gitLibraries.removeWorktree.mockReset();
    gitLibraries.getWorktrees.mockReset();
    gitLibraries.integrateWorktreeCommits.mockReset();
  });

  it('clones a project through the Git service with the selected identity', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-git-route-clone-'));
    const destination = path.join(root, 'demo');
    const normalizedDestination = destination.replace(/\\/g, '/');
    const identity = {
      id: 'work',
      name: 'Work',
      userName: 'Pi User',
      userEmail: 'pi@example.com',
      sshKey: '/home/pi/.ssh/id_ed25519',
    };
    gitLibraries.getProfile.mockReturnValue(identity);
    gitLibraries.cloneRepository.mockResolvedValue({
      success: true,
      path: normalizedDestination,
      output: 'cloned',
    });

    try {
      const app = createGitApp();

      const response = await request(app).post('/api/git/clone').send({
          remoteUrl: 'git@example.com:team/demo.git',
          destinationPath: destination,
          gitIdentityId: 'work',
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual({ success: true, path: normalizedDestination, output: 'cloned' });
      expect(gitLibraries.cloneRepository).toHaveBeenCalledWith(root, {
        url: 'git@example.com:team/demo.git',
        directoryName: 'demo',
        identity,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('typed project dispatch uses the same original handler and Documents writer', async () => {
    const writer = { markMutated: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    const documents = { registerWriterForScope: vi.fn().mockResolvedValue(writer) };
    const dispatch = registerGitRoutes(express(), { documents });
    await dispatch({ operation: 'stageGitFiles', args: ['/target/repo', ['a.ts', 'b.ts']], selection: { mode: 'live_root' } });
    expect(gitLibraries.stageFiles).toHaveBeenLastCalledWith('/target/repo', ['a.ts', 'b.ts']);
    expect(documents.registerWriterForScope).toHaveBeenCalledWith('/target/repo', expect.objectContaining({ kind: 'git-route' }), { mode: 'process', purpose: 'git-stage' });
    expect(writer.markMutated).toHaveBeenCalledOnce();
    expect(writer.close).toHaveBeenCalledOnce();
    await expect(dispatch({ operation: '/api/git/stage', args: [], selection: { mode: 'live_root' } } as never)).rejects.toThrow('Invalid project Git operation');
  });

  it('rejects remote-ext clone URLs before reaching Git', async () => {
    const app = createGitApp();

    const response = await request(app).post('/api/git/clone').send({
        remoteUrl: 'ext::sh -c calc',
        destinationPath: '/projects/demo',
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'ext:: git remotes are not supported' });
    expect(gitLibraries.cloneRepository).not.toHaveBeenCalled();
  });

  it.each([
    ['stage', 'stageFiles'],
    ['unstage', 'unstageFiles'],
  ] as const)('accepts legacy and bulk %s paths', async (route, method) => {
    const app = createGitApp();
    for (const body of [{ path: 'a.ts' }, { paths: ['a.ts', 'b.ts'] }]) {
      await request(app).post(`/api/git/${route}`).query({ directory: '/repo' }).send(body).expect(200);
      expect(gitLibraries[method]).toHaveBeenLastCalledWith('/repo', body.paths ?? [body.path]);
    }
  });

  it('rejects invalid path payloads before calling git', async () => {
    const app = createGitApp();

    const response = await request(app).post('/api/git/stage').query({ directory: '/repo' }).send({ paths: [' ', null] });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'path parameter is required' });
    expect(gitLibraries.stageFiles).not.toHaveBeenCalled();
  });

  it('registers a process writer around a workspace mutation', async () => {
    const writer = {
      markMutated: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const documents = {
      registerWriterForScope: vi.fn().mockResolvedValue(writer),
    };
    const app = createGitApp({ documents });

    await request(app).post('/api/git/stage').query({ directory: '/repo' }).send({ path: 'a.ts' }).expect(200);

    expect(documents.registerWriterForScope).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({ kind: 'git-route' }),
      { mode: 'process', purpose: 'git-stage' },
    );
    expect(writer.markMutated).toHaveBeenCalledTimes(1);
    expect(writer.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a mutation in maintenance before invoking Git', async () => {
    const error = Object.assign(new Error('Workspace is in maintenance mode'), {
      code: 'maintenance',
      statusCode: 409,
    });
    const documents = {
      registerWriterForScope: vi.fn().mockRejectedValue(error),
    };
    const app = createGitApp({ documents });

    const response = await request(app).post('/api/git/stage').query({ directory: '/repo' }).send({ path: 'a.ts' });

    expect(gitLibraries.stageFiles).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(409);
  });

  it('does not create a clone destination parent before maintenance admission', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-git-route-maintenance-'));
    const parent = path.join(root, 'not-created');
    const error = Object.assign(new Error('Workspace is in maintenance mode'), {
      code: 'maintenance',
      statusCode: 409,
    });
    const documents = {
      registerWriterForScope: vi.fn().mockRejectedValue(error),
    };
    const app = createGitApp({ documents });

    try {
      const response = await request(app).post('/api/git/clone').send({
          remoteUrl: 'https://example.com/demo.git',
          destinationPath: path.join(parent, 'demo'),
      });

      expect(response.statusCode).toBe(409);
      expect(gitLibraries.cloneRepository).not.toHaveBeenCalled();
      await expect(fs.stat(parent)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not register a writer for read-only status', async () => {
    gitLibraries.isGitRepository.mockResolvedValue(true);
    gitLibraries.getStatus.mockResolvedValue({ files: [] });
    const documents = { registerWriterForScope: vi.fn() };
    const app = createGitApp({ documents });

    await request(app).get('/api/git/status').query({ directory: '/repo' }).expect(200);

    expect(documents.registerWriterForScope).not.toHaveBeenCalled();
  });

  it('publishes successful status snapshots without letting observer failures change the response', async () => {
    gitLibraries.isGitRepository.mockResolvedValue(true);
    const status = { current: 'main', files: [{ path: 'a.ts' }], ahead: 0, behind: 0 };
    gitLibraries.getStatus.mockResolvedValue(status);
    const onStatus = vi.fn(() => { throw new Error('observer failed'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = createGitApp({ onStatus });
    try {
      const response = await request(app).get('/api/git/status').query({ directory: '/repo' });
      await Promise.resolve();
      await Promise.resolve();
      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual(status);
      expect(onStatus).toHaveBeenCalledWith('/repo', status);
      expect(warn).toHaveBeenCalledWith('Failed to observe Git status:', 'observer failed');
    } finally {
      warn.mockRestore();
    }
  });

  it('lets worktree create own and hand off one writer lease', async () => {
    const input = {
      worktreeName: 'feature',
      returnAfterDirectoryCreated: true,
    };
    const created = {
      head: '',
      name: 'feature',
      branch: 'varin/feature',
      path: '/worktrees/feature',
      directoryCreated: true,
      bootstrapStatus: { status: 'pending', phase: 'directory-created', error: null },
    };
    gitLibraries.createWorktree.mockResolvedValue(created);
    const documents = { registerWriterForScope: vi.fn() };
    const app = createGitApp({ documents });

    const response = await request(app).post('/api/git/worktrees').query({ directory: '/repo' }).send(input);

    expect(response.body).toEqual(created);
    expect(gitLibraries.createWorktree).toHaveBeenCalledWith('/repo', input, {
      documents,
      writerOwner: { kind: 'git-route', id: 'git-worktree-create:/repo' },
    });
    expect(documents.registerWriterForScope).not.toHaveBeenCalled();
  });

  it('uses only the route writers for synchronous worktree removal', async () => {
    gitLibraries.removeWorktree.mockResolvedValue(true);
    const writerRecords: WriterRecord[] = [];
    const documents = {
      registerWriterForScope: vi.fn(async () => {
        const record = {
          markMutated: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
        };
        writerRecords.push(record);
        return record;
      }),
    };
    const app = createGitApp({ documents });

    const response = await request(app).delete('/api/git/worktrees').query({ directory: '/repo' }).send({ directory: '/worktrees/feature', deleteLocalBranch: true });

    expect(response.body).toEqual({ success: true });
    expect(gitLibraries.removeWorktree).toHaveBeenCalledWith('/repo', {
      directory: '/worktrees/feature',
      deleteLocalBranch: true,
    });
    expect(documents.registerWriterForScope).toHaveBeenCalledTimes(2);
    for (const writer of writerRecords) {
      expect(writer.markMutated).toHaveBeenCalledTimes(1);
      expect(writer.close).toHaveBeenCalledTimes(1);
    }
  });

  it('uses only the route writers for synchronous integrate execution', async () => {
    const plan = {
      repoRoot: '/repo',
      sourceBranch: 'feature',
      targetBranch: 'main',
      commits: ['abcd1234'],
    };
    gitLibraries.getWorktrees.mockResolvedValue([{ path: '/worktrees/feature' }]);
    gitLibraries.integrateWorktreeCommits.mockResolvedValue({ kind: 'success', moved: 1 });
    const writerRecords: WriterRecord[] = [];
    const documents = {
      registerWriterForScope: vi.fn(async () => {
        const record = {
          markMutated: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
        };
        writerRecords.push(record);
        return record;
      }),
    };
    const app = createGitApp({ documents });

    const response = await request(app).post('/api/git/integrate/run').send({ plan });

    expect(response.body).toEqual({ kind: 'success', moved: 1 });
    expect(gitLibraries.integrateWorktreeCommits).toHaveBeenCalledWith(plan);
    expect(documents.registerWriterForScope).toHaveBeenCalledTimes(2);
    for (const writer of writerRecords) {
      expect(writer.markMutated).toHaveBeenCalledTimes(1);
      expect(writer.close).toHaveBeenCalledTimes(1);
    }
  });
});
