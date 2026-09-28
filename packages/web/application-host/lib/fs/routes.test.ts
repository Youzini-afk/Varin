import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mintOutsideFileGrant, registerFsRoutes } from './routes.js';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';
import type { Express, Request, Response } from 'express';
import type { CommandResult } from './types.js';

type RouteHandler = (request: Request, response: Response) => unknown;

interface MockPayload extends Record<string, unknown> {
  results: CommandResult[];
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  unref = vi.fn();
}

const createRouteRegistry = () => {
  const routes = new Map<string, RouteHandler>();
  return {
    app: {
      get(routePath: unknown, handler: RouteHandler) {
        routes.set(`GET ${routePath}`, handler);
      },
      post(routePath: unknown, handler: RouteHandler) {
        routes.set(`POST ${routePath}`, handler);
      },
    },
    getRoute(method: string, routePath: unknown): RouteHandler {
      const handler = routes.get(`${method} ${routePath}`);
      if (!handler) throw new Error(`Route is not registered: ${method} ${String(routePath)}`);
      return handler;
    },
  };
};

const createMockResponse = () => {
  let statusCode = 200;
  let body: unknown = null;
  const headers = new Map<string, unknown>();
  return {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
    type() {
      return this;
    },
    send(payload: unknown) {
      body = payload;
      return this;
    },
    setHeader(name: string, value: unknown) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    get statusCode() {
      return statusCode;
    },
    get body(): MockPayload {
      return body as MockPayload;
    },
  };
};

const firstCommandResult = (response: ReturnType<typeof createMockResponse>): CommandResult => {
  const result = response.body.results[0];
  if (!result) throw new Error('Expected command result');
  return result;
};

// Fake child process: emits the configured stdout then closes with the given code.
const createSpawn = ({ stdoutByCommand = {}, exitCode = 0 }: {
  exitCode?: number;
  stdoutByCommand?: Record<string, string>;
} = {}) => {
  const calls: string[] = [];
  const spawn = vi.fn((_shell: string, args: string[]) => {
    const command = args.at(-1) ?? '';
    calls.push(command);
    const child = new FakeChild();
    queueMicrotask(() => {
      const out = stdoutByCommand[command];
      if (out) child.stdout.emit('data', Buffer.from(out));
      child.emit('close', exitCode, null);
    });
    return child;
  });
  return { spawn, calls };
};

const createDeferredSpawn = ({ stdoutByCommand = {}, exitCode = 0 }: {
  exitCode?: number;
  stdoutByCommand?: Record<string, string>;
} = {}) => {
  const calls: string[] = [];
  const pending: Array<{ child: FakeChild; command: string }> = [];
  const spawn = vi.fn((_shell: string, args: string[]) => {
    const command = args.at(-1) ?? '';
    calls.push(command);
    const child = new FakeChild();
    pending.push({ child, command });
    return child;
  });
  const closeNext = () => {
    const entry = pending.shift();
    if (!entry) return;
    const out = stdoutByCommand[entry.command];
    if (out) entry.child.stdout.emit('data', Buffer.from(out));
    entry.child.emit('close', exitCode, null);
  };
  return { spawn, calls, closeNext };
};

const registerExec = ({ spawn }: { spawn: unknown }): RouteHandler => {
  const { app, getRoute } = createRouteRegistry();
  registerFsRoutes(app as unknown as Express, {
    os: { homedir: () => '/home/user' },
    path,
    fsPromises: {
      realpath: async (targetPath: string) => targetPath,
      stat: async () => ({ isDirectory: () => true }),
    },
    spawn,
    crypto: { randomUUID: (() => { let n = 0; return () => `job-${n++}`; })() },
    normalizeDirectoryPath: (value: unknown) => typeof value === 'string' ? value : '',
    resolveProjectDirectory: async () => ({ directory: '/repo' }),
    buildAugmentedPath: () => '/usr/bin',
    resolveGitBinaryForSpawn: () => 'git',
    varinUserConfigRoot: '/home/user/.config',
  });
  return getRoute('POST', '/api/fs/exec');
};

const registerWrite = (fsPromises: object, options: {
  documents?: import('../documents/authority.js').DocumentAuthority;
  path?: typeof path;
  workspaceRoot?: string;
} = {}): RouteHandler => {
  const { app, getRoute } = createRouteRegistry();
  registerFsRoutes(app as unknown as Express, {
    os: { homedir: () => '/home/user' },
    path: options.path || path.posix,
    fsPromises: {
      realpath: async (targetPath: string) => targetPath,
      ...fsPromises,
    },
    spawn: vi.fn(),
    crypto: { randomUUID: () => 'job-0' },
    normalizeDirectoryPath: (value: unknown) => typeof value === 'string' ? value : '',
    resolveProjectDirectory: async () => ({ directory: options.workspaceRoot || '/repo' }),
    buildAugmentedPath: () => '/usr/bin',
    resolveGitBinaryForSpawn: () => 'git',
    varinUserConfigRoot: '/home/user/.config',
    ...(options.documents ? { documents: options.documents } : {}),
  });
  return getRoute('POST', '/api/fs/write');
};

const registerRead = (fsPromises: object): RouteHandler => {
  const { app, getRoute } = createRouteRegistry();
  registerFsRoutes(app as unknown as Express, {
    os: { homedir: () => '/home/user' },
    path: path.posix,
    fsPromises: {
      realpath: async (targetPath: string) => targetPath,
      ...fsPromises,
    },
    spawn: vi.fn(),
    crypto: { randomUUID: () => 'job-0' },
    normalizeDirectoryPath: (value: unknown) => typeof value === 'string' ? value : '',
    resolveProjectDirectory: async () => ({ directory: '/repo' }),
    buildAugmentedPath: () => '/usr/bin',
    resolveGitBinaryForSpawn: () => 'git',
    varinUserConfigRoot: '/home/user/.config',
  });
  return getRoute('GET', '/api/fs/read');
};

const registerStat = (fsPromises: object): RouteHandler => {
  const { app, getRoute } = createRouteRegistry();
  registerFsRoutes(app as unknown as Express, {
    os: { homedir: () => '/home/user' },
    path: path.posix,
    fsPromises,
    spawn: vi.fn(),
    crypto: { randomUUID: () => 'job-0' },
    normalizeDirectoryPath: (value: unknown) => typeof value === 'string' ? value : '',
    resolveProjectDirectory: async () => ({ directory: '/repo' }),
    buildAugmentedPath: () => '/usr/bin',
    resolveGitBinaryForSpawn: () => 'git',
    varinUserConfigRoot: '/home/user/.config',
  });
  return getRoute('GET', '/api/fs/stat');
};

const registerRaw = (fsPromises: object): RouteHandler => {
  const { app, getRoute } = createRouteRegistry();
  registerFsRoutes(app as unknown as Express, {
    os: { homedir: () => '/home/user' },
    path: path.posix,
    fsPromises: {
      realpath: async (targetPath: string) => targetPath,
      ...fsPromises,
    },
    spawn: vi.fn(),
    crypto: { randomUUID: () => 'job-0' },
    normalizeDirectoryPath: (value: unknown) => typeof value === 'string' ? value : '',
    resolveProjectDirectory: async () => ({ directory: '/repo' }),
    buildAugmentedPath: () => '/usr/bin',
    resolveGitBinaryForSpawn: () => 'git',
    varinUserConfigRoot: '/home/user/.config',
  });
  return getRoute('GET', '/api/fs/raw');
};

const registerMkdir = (fsPromises: object): RouteHandler => {
  const { app, getRoute } = createRouteRegistry();
  registerFsRoutes(app as unknown as Express, {
    os: { homedir: () => '/home/user' },
    path: path.posix,
    fsPromises: {
      realpath: async (targetPath: string) => targetPath,
      ...fsPromises,
    },
    spawn: vi.fn(),
    crypto: { randomUUID: () => 'job-0' },
    normalizeDirectoryPath: (value: unknown) => typeof value === 'string' ? value : '',
    resolveProjectDirectory: async () => ({ directory: '/repo' }),
    buildAugmentedPath: () => '/usr/bin',
    resolveGitBinaryForSpawn: () => 'git',
    varinUserConfigRoot: '/home/user/.config',
  });
  return getRoute('POST', '/api/fs/mkdir');
};

const registerReveal = ({ fsPromises, spawn, platform = 'linux' }: {
  fsPromises: object;
  platform?: NodeJS.Platform;
  spawn: unknown;
}): RouteHandler => {
  const { app, getRoute } = createRouteRegistry();
  registerFsRoutes(app as unknown as Express, {
    os: { homedir: () => '/home/user' },
    path: path.posix,
    fsPromises: {
      realpath: async (targetPath: string) => targetPath,
      ...fsPromises,
    },
    spawn,
    platform,
    crypto: { randomUUID: () => 'job-0' },
    normalizeDirectoryPath: (value: unknown) => typeof value === 'string' ? value : '',
    resolveProjectDirectory: async () => ({ directory: '/repo' }),
    buildAugmentedPath: () => '/usr/bin',
    resolveGitBinaryForSpawn: () => 'git',
    varinUserConfigRoot: '/home/user/.config',
  });
  return getRoute('POST', '/api/fs/reveal');
};

const registerList = (fsPromises: object, spawn: unknown = vi.fn()): RouteHandler => {
  const { app, getRoute } = createRouteRegistry();
  registerFsRoutes(app as unknown as Express, {
    os: { homedir: () => '/home/user' },
    path: path.posix,
    fsPromises,
    spawn,
    crypto: { randomUUID: () => 'job-0' },
    normalizeDirectoryPath: (value: unknown) => typeof value === 'string' ? value : '',
    resolveProjectDirectory: async () => ({ directory: '/repo' }),
    buildAugmentedPath: () => '/usr/bin',
    resolveGitBinaryForSpawn: () => 'git',
    varinUserConfigRoot: '/home/user/.config',
  });
  return getRoute('GET', '/api/fs/list');
};

const callRoute = async (
  handler: RouteHandler,
  request: { body?: Record<string, unknown>; query?: Record<string, string> },
) => {
  const res = createMockResponse();
  await handler(request as unknown as Request, res as unknown as Response);
  return res;
};

const callExec = (handler: RouteHandler, body: Record<string, unknown>) => callRoute(handler, { body });
const callWrite = (handler: RouteHandler, body: Record<string, unknown>) => callRoute(handler, { body });
const callRead = (handler: RouteHandler, query: Record<string, string>) => callRoute(handler, { query });
const callStat = (handler: RouteHandler, query: Record<string, string>) => callRoute(handler, { query });
const callRaw = (handler: RouteHandler, query: Record<string, string>) => callRoute(handler, { query });
const callMkdir = (handler: RouteHandler, body: Record<string, unknown>) => callRoute(handler, { body });
const callReveal = (handler: RouteHandler, body: Record<string, unknown>) => callRoute(handler, { body });
const callList = (handler: RouteHandler, query: Record<string, string>) => callRoute(handler, { query });

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
    const handler = registerList(fsPromises);

    const res = await callList(handler, { path: '/repo' });

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
    const handler = registerList(fsPromises);

    const res = await callList(handler, { path: '/repo/linked-workspace' });

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
    const handler = registerList({
      realpath: vi.fn(async () => { throw missing; }),
      stat: vi.fn(),
      readdir: vi.fn(),
    });

    const res = await callList(handler, { path: '/repo/.opencode/plans' });

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Directory not found', reason: 'not-found' });
  });

  it('returns a stable reason for operating-system permission failures', async () => {
    const denied = Object.assign(new Error('denied'), { code: 'EPERM' });
    const handler = registerList({
      realpath: vi.fn(async () => { throw denied; }),
      stat: vi.fn(),
      readdir: vi.fn(),
    });

    const res = await callList(handler, { path: '/restricted' });

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
    const handler = registerWrite(fsPromises);

    const res = await callWrite(handler, { path: '/repo/file.txt', content: 'same' });

    expect(res.body).toEqual({ success: true, path: '/repo/file.txt' });
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
  });

  it('writes a file when content changed', async () => {
    const fsPromises = {
      readFile: vi.fn(async () => 'old'),
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn<(filePath: string, content: string, encoding: string) => Promise<void>>(async () => undefined),
      rename: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
    };
    const handler = registerWrite(fsPromises);

    const res = await callWrite(handler, { path: '/repo/file.txt', content: 'new' });

    expect(res.body).toEqual({ success: true, path: '/repo/file.txt' });
    expect(fsPromises.mkdir).toHaveBeenCalledWith('/repo', { recursive: true });
    const tmp = fsPromises.writeFile.mock.calls[0]?.[0];
    if (!tmp) throw new Error('Expected temporary write path');
    expect(tmp).toMatch(/^\/repo\/file\.txt\.tmp-/);
    expect(fsPromises.writeFile).toHaveBeenCalledWith(tmp, 'new', 'utf8');
    expect(fsPromises.rename).toHaveBeenCalledWith(tmp, '/repo/file.txt');
    expect(fsPromises.unlink).not.toHaveBeenCalled();
  });

  it('writes through existing symlinks without replacing the link', async () => {
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => {
        if (targetPath === '/repo/link.txt') return '/repo/target.txt';
        return targetPath;
      }),
      readFile: vi.fn(async () => 'old'),
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn<(filePath: string, content: string, encoding: string) => Promise<void>>(async () => undefined),
      rename: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
    };
    const handler = registerWrite(fsPromises);

    const res = await callWrite(handler, { path: '/repo/link.txt', content: 'new' });

    expect(res.body).toEqual({ success: true, path: '/repo/link.txt' });
    expect(fsPromises.readFile).toHaveBeenCalledWith('/repo/target.txt', 'utf8');
    const tmp = fsPromises.writeFile.mock.calls[0]?.[0];
    if (!tmp) throw new Error('Expected temporary write path');
    expect(tmp).toMatch(/^\/repo\/target\.txt\.tmp-/);
    expect(fsPromises.rename).toHaveBeenCalledWith(tmp, '/repo/target.txt');
    expect(fsPromises.rename).not.toHaveBeenCalledWith(expect.any(String), '/repo/link.txt');
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
    const handler = registerWrite(fsPromises);

    const res = await callWrite(handler, { path: '/repo/link.txt', content: 'new' });

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Access denied' });
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
    expect(fsPromises.rename).not.toHaveBeenCalled();
  });

  it('records workspace mutations and refuses writes during maintenance', async () => {
    const harness = await createDocumentAuthorityHarness();
    try {
      const handler = registerWrite(fs.promises, {
        documents: harness.authority,
        workspaceRoot: harness.workspaceRoot,
        path,
      });
      const before = await harness.authority.inspectMutation(harness.identity.workspaceId);

      const written = await callWrite(handler, { path: path.join(harness.workspaceRoot, 'tracked.txt'), content: 'tracked' });
      expect(written.statusCode).toBe(200);
      const after = await harness.authority.inspectMutation(harness.identity.workspaceId);
      expect(after.mutationRevision).toBeGreaterThan(before.mutationRevision);

      await harness.authority.setMaintenance(harness.identity.workspaceId, true);
      const rejected = await callWrite(handler, { path: path.join(harness.workspaceRoot, 'late.txt'), content: 'late' });
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
      const handler = registerStat({
        realpath: vi.fn(async () => { throw new Error('Invalid package /repo/app.asar'); }),
        stat: vi.fn(),
      });
      const optional = await callStat(handler, { path: '/repo/app.asar', optional: 'true' });
      expect(optional.statusCode).toBe(200);
      expect(optional.body).toEqual({ path: '/repo/app.asar', exists: false });
      const required = await callStat(handler, { path: '/repo/app.asar' });
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
    const handler = registerRead(fsPromises);

    const res = await callRead(handler, { path: '/etc/passwd', allowOutsideWorkspace: 'true' });

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
    const handler = registerRead(fsPromises);

    const res = await callRead(handler, {
      path: '/outside/plan.txt',
      allowOutsideWorkspace: 'true',
      outsideFileGrant: grant.outsideFileGrant,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('secret');
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
    const handler = registerRead(fsPromises);

    const res = await callRead(handler, {
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
    const handler = registerRaw(fsPromises);

    const res = await callRaw(handler, {
      path: '/outside/image.png',
      allowOutsideWorkspace: 'true',
      outsideFileGrant: grant.outsideFileGrant,
    });

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('referrer-policy')).toBe('no-referrer');
  });

  it('allows explicit outside-workspace directory creation for project onboarding', async () => {
    const fsPromises = {
      mkdir: vi.fn(async () => undefined),
    };
    const handler = registerMkdir(fsPromises);

    const res = await callMkdir(handler, { path: '/tmp/staging', allowOutsideWorkspace: true });

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
    const handler = registerRead(fsPromises);

    const res = await callRead(handler, { path: '/repo/file.txt' });

    expect(res.body).toBe('');
    expect(fsPromises.readFile).toHaveBeenCalledTimes(4);
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
    const handler = registerReveal({
      fsPromises: {
        access: vi.fn(async () => undefined),
        stat: vi.fn(async () => ({ isDirectory: () => false })),
      },
      spawn,
    });

    const res = await callReveal(handler, { path: '/repo/file.txt' });

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
    const handler = registerReveal({
      fsPromises: {
        access: vi.fn(async () => undefined),
        stat: vi.fn(async () => ({ isDirectory: () => false })),
      },
      spawn,
    });

    const res = await callReveal(handler, { path: '/repo/file.txt' });

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
    const handler = registerExec({ spawn });

    const res = await callExec(handler, { commands: ['id'], cwd: '/repo', background: true });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Background command execution is not allowed' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects command execution outside the workspace', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { spawn } = createSpawn();
    const handler = registerExec({ spawn });

    const res = await callExec(handler, { commands: ['id'], cwd: '/' });

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Path is outside of active workspace' });
    expect(spawn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('caches an allowlisted git rev-parse across identical requests', async () => {
    const command = 'git rev-parse --absolute-git-dir --git-common-dir';
    const { spawn, calls } = createSpawn({ stdoutByCommand: { [command]: '/repo/.git\n.git\n' } });
    const handler = registerExec({ spawn });

    const first = await callExec(handler, { commands: [command], cwd: '/repo' });
    const second = await callExec(handler, { commands: [command], cwd: '/repo' });

    expect(firstCommandResult(first).stdout).toBe('/repo/.git\n.git');
    expect(firstCommandResult(second).stdout).toBe('/repo/.git\n.git');
    expect(second.body.success).toBe(true);
    // Spawned once; the second request is served from cache.
    expect(calls.length).toBe(1);
  });

  it('dedupes concurrent identical git-read requests while the first is in flight', async () => {
    const command = 'git rev-parse --absolute-git-dir --git-common-dir';
    const { spawn, calls, closeNext } = createDeferredSpawn({ stdoutByCommand: { [command]: '/repo/.git\n.git\n' } });
    const handler = registerExec({ spawn });

    const first = callExec(handler, { commands: [command], cwd: '/repo' });
    const second = callExec(handler, { commands: [command], cwd: '/repo' });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.length).toBe(1);

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
    const handler = registerExec({ spawn });

    const first = await callExec(handler, { commands: [firstCommand], cwd: '/repo' });
    const second = await callExec(handler, { commands: [secondCommand], cwd: '/repo' });

    expect(firstCommandResult(first).command).toBe(firstCommand);
    expect(firstCommandResult(second).command).toBe(secondCommand);
    expect(calls.length).toBe(1);
  });

  it('keys the cache by working directory', async () => {
    const command = 'git rev-parse --absolute-git-dir';
    const { spawn, calls } = createSpawn({ stdoutByCommand: { [command]: '/x/.git\n' } });
    const handler = registerExec({ spawn });

    await callExec(handler, { commands: [command], cwd: '/repo/a' });
    await callExec(handler, { commands: [command], cwd: '/repo/b' });

    expect(calls.length).toBe(2);
  });

  it('never caches non-allowlisted commands', async () => {
    const command = 'git status';
    const { spawn, calls } = createSpawn({ stdoutByCommand: { [command]: 'clean\n' } });
    const handler = registerExec({ spawn });

    await callExec(handler, { commands: [command], cwd: '/repo' });
    await callExec(handler, { commands: [command], cwd: '/repo' });

    expect(calls.length).toBe(2);
  });

  it('does not cache failed git-read results', async () => {
    const command = 'git rev-parse --absolute-git-dir';
    const { spawn, calls } = createSpawn({ stdoutByCommand: {}, exitCode: 128 });
    const handler = registerExec({ spawn });

    await callExec(handler, { commands: [command], cwd: '/repo/not-a-repo' });
    await callExec(handler, { commands: [command], cwd: '/repo/not-a-repo' });

    expect(calls.length).toBe(2);
  });

  it('disables caching when TTL is 0', async () => {
    process.env.VARIN_GIT_READ_CACHE_TTL_MS = '0';
    const command = 'git rev-parse --absolute-git-dir';
    const { spawn, calls } = createSpawn({ stdoutByCommand: { [command]: '/repo/.git\n' } });
    const handler = registerExec({ spawn });

    await callExec(handler, { commands: [command], cwd: '/repo' });
    await callExec(handler, { commands: [command], cwd: '/repo' });

    expect(calls.length).toBe(2);
  });

  it('re-runs once a cached entry ages past the TTL', async () => {
    vi.useFakeTimers();
    try {
      const command = 'git rev-parse --absolute-git-dir';
      const { spawn, calls } = createSpawn({ stdoutByCommand: { [command]: '/repo/.git\n' } });
      const handler = registerExec({ spawn }); // default 30s TTL

      await callExec(handler, { commands: [command], cwd: '/repo' });
      vi.advanceTimersByTime(31_000);
      await callExec(handler, { commands: [command], cwd: '/repo' });

      // Stale entry is not served; a fresh subprocess fires.
      expect(calls.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the cache by evicting the least-recently-used entry past the count cap', async () => {
    const command = 'git rev-parse --absolute-git-dir';
    const { spawn, calls } = createSpawn(); // exit 0, empty stdout — still cacheable
    const handler = registerExec({ spawn });

    // Fill to the 500-entry ceiling with distinct working directories.
    for (let i = 0; i < 500; i += 1) {
      await callExec(handler, { commands: [command], cwd: `/repo/worktree-${i}` });
    }
    const afterFill = calls.length;
    expect(afterFill).toBe(500);

    // One more distinct dir evicts the oldest entry (/repo/worktree-0).
    await callExec(handler, { commands: [command], cwd: '/repo/worktree-overflow' });
    // Evicted entry must re-run; a surviving entry must still be served.
    await callExec(handler, { commands: [command], cwd: '/repo/worktree-0' });   // evicted -> spawns
    await callExec(handler, { commands: [command], cwd: '/repo/worktree-499' }); // cached  -> no spawn

    expect(calls.length).toBe(afterFill + 2);
  });
});

describe('fs raw download Content-Disposition', () => {
  it('uses RFC 5987 filename*= encoding for non-ASCII filenames on download', async () => {
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => targetPath),
      stat: vi.fn(async () => ({ isFile: () => true, size: 6 })),
      readFile: vi.fn(async () => Buffer.from('content')),
    };
    const handler = registerRaw(fsPromises);

    const res = await callRaw(handler, {
      path: '/repo/文件.txt',
      download: 'true',
    });

    expect(res.statusCode).toBe(200);
    const cd = res.getHeader('content-disposition');
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
    const handler = registerRaw(fsPromises);

    const res = await callRaw(handler, { path: '/repo/readme.txt', download: 'true' });

    expect(res.statusCode).toBe(200);
    const cd = res.getHeader('content-disposition');
    expect(cd).toContain('filename="readme.txt"');
    expect(cd).toContain("filename*=UTF-8''readme.txt");
  });
});
