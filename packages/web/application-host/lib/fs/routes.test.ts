import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request, { type Response } from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintOutsideFileGrant, registerFsRoutes } from './routes.js';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';
import type { CommandResult } from './types.js';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  unref = vi.fn();
}

// Only the process boundary is controlled; requests use the real Express router.
const createSpawn = ({ stdoutByCommand = {}, exitCode = 0, deferred = false }: {
  exitCode?: number;
  stdoutByCommand?: Record<string, string>;
  deferred?: boolean;
} = {}) => {
  const calls: string[] = [];
  const pending: Array<() => void> = [];
  const spawn = vi.fn((_shell: string, args: string[]) => {
    const command = args.at(-1) ?? '';
    calls.push(command);
    const child = new FakeChild();
    const close = () => {
      const out = stdoutByCommand[command];
      if (out) child.stdout.emit('data', Buffer.from(out));
      child.emit('close', exitCode, null);
    };
    if (deferred) pending.push(close); else queueMicrotask(close);
    return child;
  });
  return { spawn, calls, closeNext: () => pending.shift()?.() };
};

const createFsApp = (options: {
  fsPromises?: object;
  spawn?: unknown;
  platform?: NodeJS.Platform;
  documents?: import('../documents/authority.js').DocumentAuthority;
  path?: typeof path;
  workspaceRoot?: string;
} = {}) => {
  const app = express();
  app.use(express.json());
  registerFsRoutes(app, {
    os: { homedir: () => '/home/user' },
    path: options.path ?? path.posix,
    fsPromises: {
      realpath: async (targetPath: string) => targetPath,
      stat: async () => ({ isDirectory: () => true }),
      ...options.fsPromises,
    },
    spawn: options.spawn ?? vi.fn(),
    platform: options.platform ?? 'linux',
    crypto: { randomUUID: (() => { let n = 0; return () => `job-${n++}`; })() },
    normalizeDirectoryPath: (value: unknown) => typeof value === 'string' ? value : '',
    resolveProjectDirectory: async () => ({ directory: options.workspaceRoot ?? '/repo' }),
    buildAugmentedPath: () => '/usr/bin',
    resolveGitBinaryForSpawn: () => 'git',
    varinUserConfigRoot: '/home/user/.config',
    ...(options.documents ? { documents: options.documents } : {}),
  });
  return app;
};

const firstCommandResult = (response: Response): CommandResult => {
  const result = (response.body as { results: CommandResult[] }).results[0];
  if (!result) throw new Error('Expected command result');
  return result;
};

describe('fs list', () => {
  it('returns directories, files, and resolved directory symlinks', async () => {
    const dirent = (name: string, type: 'directory' | 'file' | 'symlink') => ({
      name,
      isDirectory: () => type === 'directory',
      isFile: () => type === 'file',
      isSymbolicLink: () => type === 'symlink',
    });
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => targetPath),
      stat: vi.fn(async () => ({ isDirectory: () => true })),
      readdir: vi.fn(async () => [
        dirent('src', 'directory'),
        dirent('README.md', 'file'),
        dirent('linked-package', 'symlink'),
      ]),
    };
    const handler = createFsApp({ fsPromises });

    const res = await request(handler).get('/api/fs/list').query({ path: '/repo' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      path: '/repo',
      entries: [
        { name: 'src', path: '/repo/src', isDirectory: true, isFile: false, isSymbolicLink: false },
        { name: 'README.md', path: '/repo/README.md', isDirectory: false, isFile: true, isSymbolicLink: false },
        { name: 'linked-package', path: '/repo/linked-package', isDirectory: true, isFile: false, isSymbolicLink: true },
      ],
    });
  });

  it('keeps listed entries in the requested path space when the directory is a symlink', async () => {
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => (
        targetPath === '/repo/linked-workspace' ? '/physical/workspace' : targetPath
      )),
      stat: vi.fn(async () => ({ isDirectory: () => true })),
      readdir: vi.fn(async () => [{
        name: 'src',
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false,
      }]),
    };
    const handler = createFsApp({ fsPromises });

    const res = await request(handler).get('/api/fs/list').query({ path: '/repo/linked-workspace' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      path: '/repo/linked-workspace',
      entries: [{
        name: 'src',
        path: '/repo/linked-workspace/src',
        isDirectory: true,
        isFile: false,
        isSymbolicLink: false,
      }],
    });
    expect(fsPromises.readdir).toHaveBeenCalledWith('/physical/workspace', { withFileTypes: true });
  });

  it('returns the normal missing-directory error for every path', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const handler = createFsApp({ fsPromises: {
      realpath: vi.fn(async () => { throw missing; }),
      stat: vi.fn(),
      readdir: vi.fn(),
    } });

    const res = await request(handler).get('/api/fs/list').query({ path: '/repo/.opencode/plans' });

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Directory not found', reason: 'not-found' });
  });

  it('returns a stable reason for operating-system permission failures', async () => {
    const denied = Object.assign(new Error('denied'), { code: 'EPERM' });
    const handler = createFsApp({ fsPromises: {
      realpath: vi.fn(async () => { throw denied; }),
      stat: vi.fn(),
      readdir: vi.fn(),
    } });

    const res = await request(handler).get('/api/fs/list').query({ path: '/restricted' });

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Access to directory denied', reason: 'os-permission' });
  });
});

describe('fs write', () => {
  it('does not rewrite a file when content is unchanged', async () => {
    const fsPromises = {
      readFile: vi.fn(async () => 'same'),
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn<(filePath: string, content: string, encoding: string) => Promise<void>>(async () => undefined),
    };
    const handler = createFsApp({ fsPromises });

    const res = await request(handler).post('/api/fs/write').send({ path: '/repo/file.txt', content: 'same' });

    expect(res.body).toEqual({ success: true, path: '/repo/file.txt' });
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
  });

  it('writes through an admitted symlink without replacing the link', async () => {
    const harness = await createDocumentAuthorityHarness();
    const target = path.join(harness.workspaceRoot, 'target');
    const targetFile = path.join(target, 'note.txt');
    const alias = path.join(harness.workspaceRoot, 'alias');
    try {
      await fs.promises.mkdir(target);
      await fs.promises.writeFile(targetFile, 'old');
      // Windows junctions avoid requiring symlink privileges. On POSIX, link the
      // file itself so an atomic rename to the request path would break this test.
      const windows = process.platform === 'win32';
      await fs.promises.symlink(windows ? target : targetFile, alias, windows ? 'junction' : 'file');
      const requestedPath = windows ? path.join(alias, 'note.txt') : alias;
      const app = createFsApp({ fsPromises: fs.promises, workspaceRoot: harness.workspaceRoot, path });
      await request(app).post('/api/fs/write').send({ path: requestedPath, content: 'new' }).expect(200);
      expect(await fs.promises.readFile(targetFile, 'utf8')).toBe('new');
      expect((await fs.promises.lstat(alias)).isSymbolicLink()).toBe(true);
      expect(await fs.promises.readdir(target)).toEqual(['note.txt']);
    } finally {
      await harness.cleanup();
    }
  });

  it('rejects existing symlinks that resolve outside the workspace', async () => {
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => {
        if (targetPath === '/repo/link.txt') return '/outside/target.txt';
        return targetPath;
      }),
      readFile: vi.fn(async () => 'old'),
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
    };
    const handler = createFsApp({ fsPromises });

    const res = await request(handler).post('/api/fs/write').send({ path: '/repo/link.txt', content: 'new' });

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Access denied' });
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
    expect(fsPromises.rename).not.toHaveBeenCalled();
  });

  it('records workspace mutations and refuses writes during maintenance', async () => {
    const harness = await createDocumentAuthorityHarness();
    try {
      const handler = createFsApp({ fsPromises: fs.promises,
        documents: harness.authority,
        workspaceRoot: harness.workspaceRoot,
        path,
      });
      const before = await harness.authority.inspectMutation(harness.identity.workspaceId);

      const written = await request(handler).post('/api/fs/write').send({ path: path.join(harness.workspaceRoot, 'tracked.txt'), content: 'tracked' });
      expect(written.statusCode).toBe(200);
      const after = await harness.authority.inspectMutation(harness.identity.workspaceId);
      expect(after.mutationRevision).toBeGreaterThan(before.mutationRevision);

      await harness.authority.setMaintenance(harness.identity.workspaceId, true);
      const rejected = await request(handler).post('/api/fs/write').send({ path: path.join(harness.workspaceRoot, 'late.txt'), content: 'late' });
      expect(rejected.statusCode).toBe(409);
      expect(fs.existsSync(path.join(harness.workspaceRoot, 'late.txt'))).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });
});

describe('fs stat', () => {
  it('treats Electron invalid-asar errors as a missing optional path or bad required path', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const handler = createFsApp({ fsPromises: {
        realpath: vi.fn(async () => { throw new Error('Invalid package /repo/app.asar'); }),
        stat: vi.fn(),
      } });
      const optional = await request(handler).get('/api/fs/stat').query({ path: '/repo/app.asar', optional: 'true' });
      expect(optional.statusCode).toBe(200);
      expect(optional.body).toEqual({ path: '/repo/app.asar', exists: false });
      const required = await request(handler).get('/api/fs/stat').query({ path: '/repo/app.asar' });
      expect(required.statusCode).toBe(400);
      expect(required.body).toEqual({ error: 'Invalid archive path' });
      expect(logged).not.toHaveBeenCalled();
    } finally { logged.mockRestore(); }
  });
});

describe('fs read', () => {
  it('rejects outside workspace reads without a grant', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fsPromises = {
      stat: vi.fn(async () => ({ isFile: () => true, size: 3 })),
      readFile: vi.fn(async () => 'secret'),
    };
    const handler = createFsApp({ fsPromises });

    const res = await request(handler).get('/api/fs/read').query({ path: '/etc/passwd', allowOutsideWorkspace: 'true' });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Outside workspace file access requires a grant' });
    expect(fsPromises.readFile).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('allows outside workspace reads with an exact-path grant', async () => {
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => targetPath),
      stat: vi.fn(async () => ({ isFile: () => true, size: 6 })),
      readFile: vi.fn(async () => 'secret'),
    };
    const grant = await mintOutsideFileGrant('/outside/plan.txt', {
      fsPromises,
      path: path.posix,
      crypto: { randomUUID: () => 'grant-read' },
    });
    const handler = createFsApp({ fsPromises });

    const res = await request(handler).get('/api/fs/read').query({
      path: '/outside/plan.txt',
      allowOutsideWorkspace: 'true',
      outsideFileGrant: grant.outsideFileGrant,
    });

    expect(res.statusCode).toBe(200);
    expect(res.text).toBe('secret');
  });

  it('rejects outside workspace grants for a different canonical path', async () => {
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => targetPath),
      stat: vi.fn(async () => ({ isFile: () => true, size: 6 })),
      readFile: vi.fn(async () => 'secret'),
    };
    const grant = await mintOutsideFileGrant('/outside/a.txt', {
      fsPromises,
      path: path.posix,
      crypto: { randomUUID: () => 'grant-mismatch' },
    });
    const handler = createFsApp({ fsPromises });

    const res = await request(handler).get('/api/fs/read').query({
      path: '/outside/b.txt',
      allowOutsideWorkspace: 'true',
      outsideFileGrant: grant.outsideFileGrant,
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Outside workspace file grant does not match requested path' });
    expect(fsPromises.readFile).not.toHaveBeenCalled();
  });

  it('sets no-referrer on raw responses served through outside file grants', async () => {
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => targetPath),
      stat: vi.fn(async () => ({ isFile: () => true, size: 6 })),
      readFile: vi.fn(async () => Buffer.from('secret')),
    };
    const grant = await mintOutsideFileGrant('/outside/image.png', {
      scopes: ['raw'],
      fsPromises,
      path: path.posix,
      crypto: { randomUUID: () => 'grant-raw' },
    });
    const handler = createFsApp({ fsPromises });

    const res = await request(handler).get('/api/fs/raw').query({
      path: '/outside/image.png',
      allowOutsideWorkspace: 'true',
      outsideFileGrant: grant.outsideFileGrant,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('allows explicit outside-workspace directory creation for project onboarding', async () => {
    const fsPromises = {
      mkdir: vi.fn(async () => undefined),
    };
    const handler = createFsApp({ fsPromises });

    const res = await request(handler).post('/api/fs/mkdir').send({ path: '/tmp/staging', allowOutsideWorkspace: true });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, path: '/tmp/staging' });
    expect(fsPromises.mkdir).toHaveBeenCalledWith('/tmp/staging', { recursive: true });
  });

  it('logs when empty-read retries are exhausted after non-empty stat', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fsPromises = {
      stat: vi.fn(async () => ({ isFile: () => true, size: 3 })),
      readFile: vi.fn(async () => ''),
    };
    const handler = createFsApp({ fsPromises });

    const res = await request(handler).get('/api/fs/read').query({ path: '/repo/file.txt' });

    expect(res.text).toBe('');
    expect(fsPromises.readFile.mock.calls.length).toBeGreaterThan(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Read retry exhausted for /repo/file.txt'));
    warn.mockRestore();
  });
});

describe('fs reveal', () => {
  it('returns an error when the desktop launcher cannot start', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const child = new FakeChild();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' })));
      return child;
    });
    const handler = createFsApp({
      fsPromises: {
        access: vi.fn(async () => undefined),
        stat: vi.fn(async () => ({ isDirectory: () => false })),
      },
      spawn,
    });

    const res = await request(handler).post('/api/fs/reveal').send({ path: '/repo/file.txt' });

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to launch file browser' });
    expect(child.unref).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('returns success only after the detached launcher starts', async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    const handler = createFsApp({
      fsPromises: {
        access: vi.fn(async () => undefined),
        stat: vi.fn(async () => ({ isDirectory: () => false })),
      },
      spawn,
    });

    const res = await request(handler).post('/api/fs/reveal').send({ path: '/repo/file.txt' });

    expect(res.body).toEqual({ success: true, path: '/repo/file.txt' });
    expect(child.unref).toHaveBeenCalledOnce();
  });
});

describe('fs exec git-read cache', () => {
  beforeEach(() => {
    delete process.env.VARIN_GIT_READ_CACHE_TTL_MS;
  });

  afterEach(() => {
    delete process.env.VARIN_GIT_READ_CACHE_TTL_MS;
  });

  it('rejects background command execution', async () => {
    const { spawn } = createSpawn();
    const handler = createFsApp({ spawn });

    const res = await request(handler).post('/api/fs/exec').send({ commands: ['id'], cwd: '/repo', background: true });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Background command execution is not allowed' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects command execution outside the workspace', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { spawn } = createSpawn();
    const handler = createFsApp({ spawn });

    const res = await request(handler).post('/api/fs/exec').send({ commands: ['id'], cwd: '/' });

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Path is outside of active workspace' });
    expect(spawn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('caches an allowlisted git rev-parse across identical requests', async () => {
    const command = 'git rev-parse --absolute-git-dir --git-common-dir';
    const { spawn, calls } = createSpawn({ stdoutByCommand: { [command]: '/repo/.git\n.git\n' } });
    const handler = createFsApp({ spawn });

    const first = await request(handler).post('/api/fs/exec').send({ commands: [command], cwd: '/repo' });
    const second = await request(handler).post('/api/fs/exec').send({ commands: [command], cwd: '/repo' });

    expect(firstCommandResult(first).stdout).toBe('/repo/.git\n.git');
    expect(firstCommandResult(second).stdout).toBe('/repo/.git\n.git');
    expect(second.body.success).toBe(true);
    // Spawned once; the second request is served from cache.
    expect(calls.length).toBe(1);
  });

  it('dedupes concurrent identical git-read requests while the first is in flight', async () => {
    const command = 'git rev-parse --absolute-git-dir --git-common-dir';
    const { spawn, calls, closeNext } = createSpawn({ deferred: true, stdoutByCommand: { [command]: '/repo/.git\n.git\n' } });
    const handler = createFsApp({ spawn });

    const first = request(handler).post('/api/fs/exec').send({ commands: [command], cwd: '/repo' }).then(response => response);
    const second = request(handler).post('/api/fs/exec').send({ commands: [command], cwd: '/repo' }).then(response => response);

    await vi.waitFor(() => expect(calls.length).toBe(1));

    closeNext();
    const [firstRes, secondRes] = await Promise.all([first, second]);

    expect(firstCommandResult(firstRes).stdout).toBe('/repo/.git\n.git');
    expect(firstCommandResult(secondRes).stdout).toBe('/repo/.git\n.git');
    expect(calls.length).toBe(1);
  });

  it('returns the current request command for normalized cache hits', async () => {
    const firstCommand = 'git   rev-parse   --absolute-git-dir';
    const secondCommand = 'git rev-parse --absolute-git-dir';
    const { spawn, calls } = createSpawn({ stdoutByCommand: { [firstCommand]: '/repo/.git\n' } });
    const handler = createFsApp({ spawn });

    const first = await request(handler).post('/api/fs/exec').send({ commands: [firstCommand], cwd: '/repo' });
    const second = await request(handler).post('/api/fs/exec').send({ commands: [secondCommand], cwd: '/repo' });

    expect(firstCommandResult(first).command).toBe(firstCommand);
    expect(firstCommandResult(second).command).toBe(secondCommand);
    expect(calls.length).toBe(1);
  });

  it('keys the cache by working directory', async () => {
    const command = 'git rev-parse --absolute-git-dir';
    const { spawn, calls } = createSpawn({ stdoutByCommand: { [command]: '/x/.git\n' } });
    const handler = createFsApp({ spawn });

    await request(handler).post('/api/fs/exec').send({ commands: [command], cwd: '/repo/a' });
    await request(handler).post('/api/fs/exec').send({ commands: [command], cwd: '/repo/b' });

    expect(calls.length).toBe(2);
  });

  it('never caches non-allowlisted commands', async () => {
    const command = 'git status';
    const { spawn, calls } = createSpawn({ stdoutByCommand: { [command]: 'clean\n' } });
    const handler = createFsApp({ spawn });

    await request(handler).post('/api/fs/exec').send({ commands: [command], cwd: '/repo' });
    await request(handler).post('/api/fs/exec').send({ commands: [command], cwd: '/repo' });

    expect(calls.length).toBe(2);
  });

  it('does not cache failed git-read results', async () => {
    const command = 'git rev-parse --absolute-git-dir';
    const { spawn, calls } = createSpawn({ stdoutByCommand: {}, exitCode: 128 });
    const handler = createFsApp({ spawn });

    await request(handler).post('/api/fs/exec').send({ commands: [command], cwd: '/repo/not-a-repo' });
    await request(handler).post('/api/fs/exec').send({ commands: [command], cwd: '/repo/not-a-repo' });

    expect(calls.length).toBe(2);
  });

  it('disables caching when TTL is 0', async () => {
    process.env.VARIN_GIT_READ_CACHE_TTL_MS = '0';
    const command = 'git rev-parse --absolute-git-dir';
    const { spawn, calls } = createSpawn({ stdoutByCommand: { [command]: '/repo/.git\n' } });
    const handler = createFsApp({ spawn });

    await request(handler).post('/api/fs/exec').send({ commands: [command], cwd: '/repo' });
    await request(handler).post('/api/fs/exec').send({ commands: [command], cwd: '/repo' });

    expect(calls.length).toBe(2);
  });

  it('re-runs once a cached entry ages past the TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const command = 'git rev-parse --absolute-git-dir';
      const { spawn, calls } = createSpawn({ stdoutByCommand: { [command]: '/repo/.git\n' } });
      const handler = createFsApp({ spawn }); // default 30s TTL

      await request(handler).post('/api/fs/exec').send({ commands: [command], cwd: '/repo' });
      vi.advanceTimersByTime(31_000);
      await request(handler).post('/api/fs/exec').send({ commands: [command], cwd: '/repo' });

      // Stale entry is not served; a fresh subprocess fires.
      expect(calls.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });


});

describe('fs raw download Content-Disposition', () => {
  it('serves an authenticated image derivative with dimensions and validates cached previews', async () => {
    const { createCanvas } = await import('@napi-rs/canvas');
    const bytes = await createCanvas(32, 24).encode('png');
    const handler = createFsApp({ fsPromises: { stat: async () => ({ isFile: () => true }), readFile: async () => bytes } });
    const query = { path: '/repo/image.png', preview: 'image' };
    const response = await request(handler).get('/api/fs/raw').query(query);
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(bytes);
    expect(response.headers['x-varin-image-width']).toBe('32');
    expect(response.headers['x-varin-image-height']).toBe('24');
    const etag = response.headers.etag;
    if (!etag) throw new Error('Image preview must include its cache validator');
    const repeated = await request(handler).get('/api/fs/raw').query(query).set('if-none-match', etag);
    expect(repeated.statusCode).toBe(304);
    expect(repeated.text).toBe('');
  });
  it('uses RFC 5987 filename*= encoding for non-ASCII filenames on download', async () => {
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => targetPath),
      stat: vi.fn(async () => ({ isFile: () => true, size: 6 })),
      readFile: vi.fn(async () => Buffer.from('content')),
    };
    const handler = createFsApp({ fsPromises });

    const res = await request(handler).get('/api/fs/raw').query({
      path: '/repo/文件.txt',
      download: 'true',
    });

    expect(res.statusCode).toBe(200);
    const cd = res.headers['content-disposition'];
    expect(cd).toContain("filename*=UTF-8''");
    expect(cd).toContain(encodeURIComponent('文件.txt'));
    // ASCII fallback strips non-ASCII chars, leaving extension
    expect(cd).toContain('filename=".txt"');
  });

  it('uses plain filename for ASCII-only filenames on download', async () => {
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => targetPath),
      stat: vi.fn(async () => ({ isFile: () => true, size: 6 })),
      readFile: vi.fn(async () => Buffer.from('content')),
    };
    const handler = createFsApp({ fsPromises });

    const res = await request(handler).get('/api/fs/raw').query({ path: '/repo/readme.txt', download: 'true' });

    expect(res.statusCode).toBe(200);
    const cd = res.headers['content-disposition'];
    expect(cd).toContain('filename="readme.txt"');
    expect(cd).toContain("filename*=UTF-8''readme.txt");
  });
});
