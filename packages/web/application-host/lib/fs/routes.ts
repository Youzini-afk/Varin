import { createRealpathCache } from '../path-realpath-cache.js';
import nodeFsPromises from 'node:fs/promises';
import nodePath from 'node:path';
import { canonicalizePathIdentity } from '../workspace/path-safety.js';
import type { Express, Request, Response } from 'express';
import type { spawn as nodeSpawn } from 'node:child_process';
import type {
  CommandResult,
  ExecJob,
  FsPromises,
  FsRouteDependencies,
  OsModule,
  PathModule,
  ResolveProjectDirectory,
  WorkspacePathResult,
} from './types.js';

const EXEC_JOB_TTL_MS = 30 * 60 * 1000;
const OUTSIDE_FILE_GRANT_TTL_MS = 10 * 60 * 1000;

interface OutsideFileGrant {
  base: string;
  canonicalPath: string;
  expiresAt: number;
  scopes: Set<string>;
}

const outsideFileGrants = new Map<string, OutsideFileGrant>();

const errorRecord = (error: unknown): Record<string, unknown> => (
  error && typeof error === 'object' ? error as Record<string, unknown> : {}
);
const errorMessage = (error: unknown, fallback: string): string => (
  error instanceof Error && error.message ? error.message : fallback
);
const errorCode = (error: unknown): unknown => errorRecord(error).code;
// Electron's asar-patched realpath throws this code-less error for a missing or
// malformed .asar path. A stat probe must treat it as an invalid target rather
// than logging an ordinary missing-file probe as a Host failure.
const isInvalidAsarPackageError = (error: unknown): boolean => (
  error instanceof Error && /^Invalid package(?:\s|$)/.test(error.message)
);

const isOsPermissionError = (error: unknown): boolean => Boolean(
  error
  && typeof error === 'object'
  && ('code' in error && (error.code === 'EACCES' || error.code === 'EPERM'))
);

const sendMutationAuthorityError = (res: Response, error: unknown): Response | null => {
  const failure = errorRecord(error);
  if (failure.code !== 'maintenance' && failure.code !== 'stale-epoch') return null;
  const status = typeof failure.statusCode === 'number' && Number.isInteger(failure.statusCode) ? failure.statusCode : 409;
  return res.status(status).json({
    error: typeof failure.message === 'string' ? failure.message : 'Workspace mutation is unavailable',
    reason: failure.code,
    ...(failure.currentEpoch ? { currentEpoch: failure.currentEpoch } : {}),
  });
};

const pruneOutsideFileGrants = (): void => {
  const now = Date.now();
  for (const [token, grant] of outsideFileGrants.entries()) {
    if (!grant || grant.expiresAt <= now) {
      outsideFileGrants.delete(token);
    }
  }
};

export const mintOutsideFileGrant = async (targetPath: unknown, {
  scopes = ['stat', 'read', 'raw'],
  fsPromises = nodeFsPromises,
  path = nodePath,
  crypto = globalThis.crypto,
}: {
  crypto?: { randomUUID(): string };
  fsPromises?: unknown;
  path?: PathModule;
  scopes?: string[];
} = {}) => {
  const fileSystem = fsPromises as FsPromises;
  const raw = typeof targetPath === 'string' ? targetPath.trim() : '';
  if (!raw) {
    throw new Error('Path is required');
  }
  const canonicalPath = await fileSystem.realpath(raw);
  const stats = await fileSystem.stat(canonicalPath);
  if (!stats.isFile()) {
    throw new Error('Outside file grants require a file path');
  }
  pruneOutsideFileGrants();
  const token = typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const normalizedScopes = new Set(
    (Array.isArray(scopes) ? scopes : [])
      .filter((scope): scope is string => typeof scope === 'string' && Boolean(scope.trim()))
      .map((scope) => scope.trim())
  );
  if (normalizedScopes.size === 0) {
    normalizedScopes.add('read');
  }
  const grant = {
    canonicalPath,
    base: path.dirname(canonicalPath),
    scopes: normalizedScopes,
    expiresAt: Date.now() + OUTSIDE_FILE_GRANT_TTL_MS,
  };
  outsideFileGrants.set(token, grant);
  return {
    path: canonicalPath,
    outsideFileGrant: token,
    expiresAt: grant.expiresAt,
  };
};

const resolveOutsideFileGrant = async ({ token, targetPath, scope, fsPromises }: {
  fsPromises: FsPromises;
  scope: string;
  targetPath: string;
  token: unknown;
}): Promise<WorkspacePathResult> => {
  pruneOutsideFileGrants();
  if (typeof token !== 'string' || !token.trim()) {
    return { ok: false, error: 'Outside workspace file access requires a grant' };
  }
  const grant = outsideFileGrants.get(token.trim());
  if (!grant) {
    return { ok: false, error: 'Outside workspace file grant is invalid or expired' };
  }
  if (!grant.scopes.has(scope)) {
    return { ok: false, error: 'Outside workspace file grant does not allow this operation' };
  }
  const canonicalPath = await fsPromises.realpath(targetPath);
  if (canonicalPath !== grant.canonicalPath) {
    return { ok: false, error: 'Outside workspace file grant does not match requested path' };
  }
  return { ok: true, base: grant.base, resolved: canonicalPath, workspaceRoot: false, granted: true };
};

const createCommandTimeoutMs = (): number => {
  const raw = Number(process.env.VARIN_FS_EXEC_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 5 * 60 * 1000;
};

// How long a cached git-read result stays fresh. The location of a repo's git
// directory is effectively static while the app runs, so a short TTL safely
// absorbs the burst of identical lookups a fresh client (e.g. right after a
// page reload) fires for every project. Set to 0 to disable caching.
const createGitReadCacheTtlMs = (): number => {
  const raw = Number(process.env.VARIN_GIT_READ_CACHE_TTL_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 30 * 1000;
};

const createGitCheckIgnoreTimeoutMs = (): number => {
  const raw = Number(process.env.VARIN_GIT_CHECK_IGNORE_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 2500;
};

const FILE_MIME_MAP: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
});

const MAX_SERVE_BYTES = 100 * 1024 * 1024;

// Only deterministic, side-effect-free git plumbing path queries are cacheable.
// Anything outside this allowlist (including any non-git command) runs normally
// — we never cache arbitrary exec.
const normalizeCommand = (command: unknown): string =>
  typeof command === 'string' ? command.trim().replace(/\s+/g, ' ') : '';

const isCacheableGitReadCommand = (command: unknown): boolean => {
  const normalized = normalizeCommand(command);
  return /^git rev-parse(?: --(?:absolute-git-dir|git-common-dir|show-toplevel)){1,3}$/.test(normalized);
};

// Dual-constraint bound per the project's caching policy (count + bytes). Git
// rev-parse outputs are tiny, so these ceilings are generous and only guard
// against pathological growth on long-lived, many-directory deployments.
const GIT_READ_CACHE_MAX_ENTRIES = 500;
const GIT_READ_CACHE_MAX_BYTES = 1024 * 1024;

const gitReadEntryBytes = (key: string, result: CommandResult): number =>
  key.length + (result?.stdout?.length || 0) + (result?.stderr?.length || 0);

const isPathWithinRoot = (resolvedPath: string, rootPath: string, path: PathModule, os: OsModule): boolean => {
  const resolvedRoot = path.resolve(rootPath || os.homedir());
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }
  return true;
};

interface WorkspacePathOptions {
  baseDirectory?: string;
  normalizeDirectoryPath<Value>(path: Value): Value | string;
  os: OsModule;
  path: PathModule;
  varinUserConfigRoot: string;
  targetPath: unknown;
}

const resolveWorkspacePath = ({ targetPath, baseDirectory, path, os, normalizeDirectoryPath, varinUserConfigRoot }: WorkspacePathOptions): WorkspacePathResult => {
  const normalized = normalizeDirectoryPath(targetPath);
  if (!normalized || typeof normalized !== 'string') {
    return { ok: false, error: 'Path is required' };
  }

  const resolved = path.resolve(normalized);
  const resolvedBase = path.resolve(baseDirectory || os.homedir());

  if (isPathWithinRoot(resolved, resolvedBase, path, os)) {
    return { ok: true, base: resolvedBase, resolved, workspaceRoot: true };
  }

  if (isPathWithinRoot(resolved, varinUserConfigRoot, path, os)) {
    return { ok: true, base: path.resolve(varinUserConfigRoot), resolved, workspaceRoot: false };
  }

  return { ok: false, error: 'Path is outside of active workspace' };
};

const resolveWorkspacePathFromWorktrees = async ({ targetPath, baseDirectory, path, os, normalizeDirectoryPath }: Omit<WorkspacePathOptions, 'varinUserConfigRoot'>): Promise<WorkspacePathResult> => {
  const normalized = normalizeDirectoryPath(targetPath);
  if (!normalized || typeof normalized !== 'string') {
    return { ok: false, error: 'Path is required' };
  }

  const resolved = path.resolve(normalized);
  const resolvedBase = path.resolve(baseDirectory || os.homedir());

  try {
    const { getWorktrees } = await import('../git/index.js');
    const worktrees = await getWorktrees(resolvedBase);

    for (const worktree of worktrees) {
      const candidatePath = typeof worktree?.path === 'string' ? worktree.path : '';
      const candidate = normalizeDirectoryPath(candidatePath);
      if (!candidate) {
        continue;
      }
      const candidateResolved = path.resolve(candidate);
      if (isPathWithinRoot(resolved, candidateResolved, path, os)) {
        return { ok: true, base: candidateResolved, resolved, workspaceRoot: true };
      }
    }
  } catch (error) {
    console.warn('Failed to resolve worktree roots:', error);
  }

  return { ok: false, error: 'Path is outside of active workspace' };
};

interface WorkspaceContextOptions extends Omit<WorkspacePathOptions, 'baseDirectory'> {
  req: Request;
  resolveProjectDirectory: ResolveProjectDirectory;
}

const resolveWorkspacePathFromContext = async ({ req, targetPath, resolveProjectDirectory, path, os, normalizeDirectoryPath, varinUserConfigRoot }: WorkspaceContextOptions): Promise<WorkspacePathResult> => {
  const resolvedProject = await resolveProjectDirectory(req);
  if (!resolvedProject.directory) {
    return { ok: false, error: resolvedProject.error || 'Active workspace is required' };
  }

  const resolved = resolveWorkspacePath({
    targetPath,
    baseDirectory: resolvedProject.directory,
    path,
    os,
    normalizeDirectoryPath,
    varinUserConfigRoot,
  });
  if (resolved.ok || resolved.error !== 'Path is outside of active workspace') {
    return resolved;
  }

  return resolveWorkspacePathFromWorktrees({
    targetPath,
    baseDirectory: resolvedProject.directory,
    path,
    os,
    normalizeDirectoryPath,
  });
};

const resolveReadPathFromContext = async ({ req, targetPath, scope, resolveProjectDirectory, path, os, fsPromises, normalizeDirectoryPath, varinUserConfigRoot }: WorkspaceContextOptions & {
  fsPromises: FsPromises;
  scope?: string;
}): Promise<WorkspacePathResult> => {
  if (req.query?.allowOutsideWorkspace === 'true') {
    const normalized = normalizeDirectoryPath(targetPath);
    if (!normalized || typeof normalized !== 'string') {
      return { ok: false, error: 'Path is required' };
    }
    const resolved = path.resolve(normalized);
    return resolveOutsideFileGrant({
      token: req.query?.outsideFileGrant,
      targetPath: resolved,
      scope: scope ?? 'read',
      fsPromises,
    });
  }

  return resolveWorkspacePathFromContext({
    req,
    targetPath,
    resolveProjectDirectory,
    path,
    os,
    normalizeDirectoryPath,
    varinUserConfigRoot,
  });
};

const runCommandInDirectory = ({ shell, shellFlag, command, resolvedCwd, spawn, buildAugmentedPath, commandTimeoutMs }: {
  buildAugmentedPath(): string;
  command: string;
  commandTimeoutMs: number;
  resolvedCwd: string;
  shell: string;
  shellFlag: string;
  spawn: typeof nodeSpawn;
}): Promise<CommandResult> => {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const envPath = buildAugmentedPath();
    const execEnv = { ...process.env, PATH: envPath };

    const child = spawn(shell, [shellFlag, command], {
      cwd: resolvedCwd,
      env: execEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // The process may already have exited.
      }
    }, commandTimeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      resolve({
        command,
        success: false,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        error: errorMessage(error, 'Command execution failed'),
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      const exitCode = typeof code === 'number' ? code : undefined;
      const base: CommandResult = {
        command,
        success: exitCode === 0 && !timedOut,
        ...(typeof exitCode === 'number' ? { exitCode } : {}),
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      };

      if (timedOut) {
        resolve({
          ...base,
          success: false,
          error: `Command timed out after ${commandTimeoutMs}ms` + (signal ? ` (${signal})` : ''),
        });
        return;
      }

      resolve(base);
    });
  });
};

export const registerFsRoutes = (app: Express, dependencies: FsRouteDependencies): void => {
  const {
    os,
    path,
    fsPromises: rawFsPromises,
    spawn: rawSpawn,
    platform = process.platform,
    crypto,
    normalizeDirectoryPath,
    resolveProjectDirectory,
    buildAugmentedPath,
    resolveGitBinaryForSpawn,
    varinUserConfigRoot,
    documents,
    fileResources,
  } = dependencies;
  const fsPromises = rawFsPromises as FsPromises;
  const spawn = rawSpawn as typeof nodeSpawn;
  const realpathCache = createRealpathCache({
    realpath: fsPromises.realpath.bind(fsPromises),
  });

  const runWorkspaceMutation = <Result>(
    resolved: WorkspacePathResult | null,
    ownerId: string,
    operation: () => Promise<Result>,
    options: Record<string, unknown> = {},
  ): Promise<Result> => {
    if (!resolved || !resolved.ok || !resolved.workspaceRoot || typeof documents?.runMutationForScope !== 'function') {
      return operation();
    }
    return documents.runMutationForScope(
      resolved.base,
      { kind: 'web-route', id: ownerId },
      operation,
      options,
    );
  };

  const kernelFileContext = async (resolved: WorkspacePathResult | null) => {
    if (!fileResources || !documents || !resolved?.ok || !resolved.workspaceRoot) return null;
    const workspace = await documents.resolveWorkspace({ path: resolved.base });
    const inspected = await documents.inspectWorkspace(workspace.workspaceId);
    const canonicalRoot = await canonicalizePathIdentity(inspected.root, { fsPromises, pathModule: path });
    const relativeFor = (absolutePath: string): string => {
      const relative = path.relative(canonicalRoot, absolutePath);
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
        throw Object.assign(new Error('Access denied'), { code: 'EACCES' });
      }
      return relative.split(path.sep).join('/');
    };
    return {
      identity: {
        authorityId: workspace.hostId,
        canonicalRoot,
        filesystemProfile: process.platform === 'win32' ? 'windows-local' : `${process.platform}-local`,
        workspaceId: workspace.workspaceId,
      },
      relativeFor,
    };
  };

  const spawnDetached = (command: string, args: string[]): Promise<void> => new Promise((resolve, reject) => {
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: 'ignore', detached: true });
    } catch (error) {
      reject(new Error('Failed to launch file browser', { cause: error }));
      return;
    }
    const onError = (error: Error) => {
      child.removeListener('spawn', onSpawn);
      reject(new Error('Failed to launch file browser', { cause: error }));
    };
    const onSpawn = () => {
      child.removeListener('error', onError);
      child.unref();
      resolve();
    };
    child.once('error', onError);
    child.once('spawn', onSpawn);
  });

  const execJobs = new Map<string, ExecJob>();
  const commandTimeoutMs = createCommandTimeoutMs();
  const gitReadCacheTtlMs = createGitReadCacheTtlMs();
  const gitCheckIgnoreTimeoutMs = createGitCheckIgnoreTimeoutMs();
  const gitReadCache = new Map<string, { at: number; result: CommandResult }>();
  const inFlightGitReadCache = new Map<string, Promise<CommandResult>>();

  const pruneExecJobs = (): void => {
    const now = Date.now();
    for (const [jobId, job] of execJobs.entries()) {
      if (!job || typeof job !== 'object') {
        execJobs.delete(jobId);
        continue;
      }
      const updatedAt = typeof job.updatedAt === 'number' ? job.updatedAt : 0;
      if (updatedAt && now - updatedAt > EXEC_JOB_TTL_MS) {
        execJobs.delete(jobId);
      }
    }
  };

  const pruneGitReadCache = (): void => {
    if (gitReadCacheTtlMs <= 0) {
      return;
    }
    const now = Date.now();
    for (const [key, entry] of gitReadCache.entries()) {
      if (!entry || now - entry.at > gitReadCacheTtlMs) {
        gitReadCache.delete(key);
      }
    }
  };

  // Insert with LRU (oldest-first) eviction enforcing both count and byte caps.
  // Map iteration order is insertion order, so deleting+re-setting a key moves
  // it to the most-recently-used position.
  const setGitReadCacheEntry = (key: string, result: CommandResult): void => {
    gitReadCache.delete(key);
    gitReadCache.set(key, { result, at: Date.now() });

    let totalBytes = 0;
    for (const [k, entry] of gitReadCache) {
      totalBytes += gitReadEntryBytes(k, entry.result);
    }
    while (
      gitReadCache.size > GIT_READ_CACHE_MAX_ENTRIES ||
      (totalBytes > GIT_READ_CACHE_MAX_BYTES && gitReadCache.size > 1)
    ) {
      const oldest = gitReadCache.entries().next().value;
      if (!oldest) {
        break;
      }
      totalBytes -= gitReadEntryBytes(oldest[0], oldest[1].result);
      gitReadCache.delete(oldest[0]);
    }
  };

  // Runs a command, transparently serving/storing cacheable git-read results.
  // Non-cacheable commands always execute and are never stored.
  const runCommandWithGitReadCache = async ({ shell, shellFlag, command, resolvedCwd }: {
    command: string;
    resolvedCwd: string;
    shell: string;
    shellFlag: string;
  }): Promise<CommandResult> => {
    const cacheable = gitReadCacheTtlMs > 0 && isCacheableGitReadCommand(command);
    const cacheKey = cacheable ? `${resolvedCwd} ${normalizeCommand(command)}` : null;

    if (cacheKey) {
      const cached = gitReadCache.get(cacheKey);
      if (cached && Date.now() - cached.at < gitReadCacheTtlMs) {
        // Refresh recency for LRU without altering the entry's age/TTL.
        gitReadCache.delete(cacheKey);
        gitReadCache.set(cacheKey, cached);
        return { ...cached.result, command };
      }
      if (cached) {
        gitReadCache.delete(cacheKey);
      }

      const inFlight = inFlightGitReadCache.get(cacheKey);
      if (inFlight) {
        const result = await inFlight;
        return { ...result, command };
      }
    }

    const runPromise = runCommandInDirectory({
      shell,
      shellFlag,
      command,
      resolvedCwd,
      spawn,
      buildAugmentedPath,
      commandTimeoutMs,
    }).then((result) => {
      // Only cache successful results — failures may be transient.
      if (cacheKey && result && result.success) {
        setGitReadCacheEntry(cacheKey, result);
      }
      return result;
    }).finally(() => {
      if (cacheKey && inFlightGitReadCache.get(cacheKey) === runPromise) {
        inFlightGitReadCache.delete(cacheKey);
      }
    });

    if (cacheKey) {
      inFlightGitReadCache.set(cacheKey, runPromise);
    }

    return runPromise;
  };

  const runExecJob = async (job: ExecJob): Promise<void> => {
    job.status = 'running';
    job.updatedAt = Date.now();

    const results: CommandResult[] = [];
    for (const command of job.commands) {
      if (typeof command !== 'string' || !command.trim()) {
        results.push({ command: String(command ?? ''), success: false, error: 'Invalid command', stdout: '', stderr: '' });
        continue;
      }

      try {
        const result = await runCommandWithGitReadCache({
          shell: job.shell,
          shellFlag: job.shellFlag,
          command,
          resolvedCwd: job.resolvedCwd,
        });
        results.push(result);
      } catch (error) {
        results.push({
          command,
          success: false,
          error: errorMessage(error, 'Command execution failed'),
          stdout: '',
          stderr: '',
        });
      }

      job.results = results;
      job.updatedAt = Date.now();
    }

    job.results = results;
    job.success = results.every((r) => r.success);
    job.status = 'done';
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
  };

  app.get('/api/fs/home', (_req, res) => {
    try {
      const home = os.homedir();
      if (!home || typeof home !== 'string' || home.length === 0) {
        return res.status(500).json({ error: 'Failed to resolve home directory' });
      }
      return res.json({ home });
    } catch (error) {
      console.error('Failed to resolve home directory:', error);
      return res.status(500).json({ error: errorMessage(error, 'Failed to resolve home directory') });
    }
  });

  app.post('/api/fs/mkdir', async (req, res) => {
    try {
      const { path: dirPath, allowOutsideWorkspace } = req.body ?? {};
      if (typeof dirPath !== 'string' || !dirPath.trim()) {
        return res.status(400).json({ error: 'Path is required' });
      }

      let resolvedPath = '';
      let resolvedContext: WorkspacePathResult | null = null;
      if (allowOutsideWorkspace) {
        resolvedPath = path.resolve(normalizeDirectoryPath(dirPath.trim()));
        resolvedContext = { ok: true, base: path.dirname(resolvedPath), resolved: resolvedPath, workspaceRoot: false };
        if (typeof documents?.runMutationForScope === 'function') {
          const project = await resolveProjectDirectory(req).catch(() => null);
          const projectRoot = project?.directory ? path.resolve(project.directory) : '';
          if (projectRoot && isPathWithinRoot(resolvedPath, projectRoot, path, os)) {
            resolvedContext = { ok: true, base: projectRoot, resolved: resolvedPath, workspaceRoot: true };
          }
        }
      } else {
        const resolved = await resolveWorkspacePathFromContext({
          req,
          targetPath: dirPath,
          resolveProjectDirectory,
          path,
          os,
          normalizeDirectoryPath,
          varinUserConfigRoot,
        });
        if (!resolved.ok) {
          return res.status(400).json({ error: resolved.error });
        }
        resolvedPath = resolved.resolved;
        resolvedContext = resolved;
      }

      await runWorkspaceMutation(
        resolvedContext,
        'fs.mkdir',
        async () => {
          const kernel = await kernelFileContext(resolvedContext);
          if (!kernel || !fileResources) {
            await fsPromises.mkdir(resolvedPath, { recursive: true });
            return;
          }
          const resourceId = kernel.relativeFor(resolvedPath);
          await fileResources.gateFor(kernel.identity).run(
            [{ resourceId, scope: 'subtree' }],
            () => fileResources.mkdir(kernel.identity, resourceId, true),
          );
        },
      );
      return res.json({ success: true, path: resolvedPath });
    } catch (error) {
      const authorityResponse = sendMutationAuthorityError(res, error);
      if (authorityResponse) return authorityResponse;
      console.error('Failed to create directory:', error);
      return res.status(500).json({ error: errorMessage(error, 'Failed to create directory') });
    }
  });

  app.get('/api/fs/stat', async (req, res) => {
    const filePath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
    const optional = req.query.optional === 'true';
    if (!filePath) {
      return res.status(400).json({ error: 'Path is required' });
    }

    try {
      const resolved = await resolveReadPathFromContext({
        req,
        targetPath: filePath,
        scope: 'stat',
        resolveProjectDirectory,
        path,
        os,
        fsPromises,
        normalizeDirectoryPath,
        varinUserConfigRoot,
      });
      if (!resolved.ok) {
        if (req.query?.allowOutsideWorkspace === 'true') {
          console.warn(`Rejected outside-workspace stat: ${resolved.error}`);
        }
        return res.status(400).json({ error: resolved.error });
      }

      const [canonicalPath, canonicalBase] = await Promise.all([
        fsPromises.realpath(resolved.resolved),
        fsPromises.realpath(resolved.base).catch(() => path.resolve(resolved.base)),
      ]);

      if (!isPathWithinRoot(canonicalPath, canonicalBase, path, os)) {
        return res.status(403).json({ error: 'Access to file denied' });
      }

      const stats = await fsPromises.stat(canonicalPath);
      if (!stats.isFile()) {
        return res.status(400).json({ error: 'Specified path is not a file' });
      }

      return res.json({ path: canonicalPath, isFile: true, size: stats.size, mtimeMs: stats.mtimeMs });
    } catch (error) {
      const err = error;
      if (errorCode(err) === 'ENOENT') {
        if (optional) {
          return res.json({ path: filePath, exists: false });
        }
        return res.status(404).json({ error: 'File not found' });
      }
      if (errorCode(err) === 'EACCES') {
        return res.status(403).json({ error: 'Access to file denied' });
      }
      if (isInvalidAsarPackageError(err)) {
        return optional
          ? res.json({ path: filePath, exists: false })
          : res.status(400).json({ error: 'Invalid archive path' });
      }
      console.error('Failed to stat file:', error);
      return res.status(500).json({ error: errorMessage(error, 'Failed to stat file') });
    }
  });

  app.get('/api/fs/read', async (req, res) => {
    const filePath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
    const optional = req.query.optional === 'true';
    if (!filePath) {
      return res.status(400).json({ error: 'Path is required' });
    }

    try {
      const resolved = await resolveReadPathFromContext({
        req,
        targetPath: filePath,
        scope: 'read',
        resolveProjectDirectory,
        path,
        os,
        fsPromises,
        normalizeDirectoryPath,
        varinUserConfigRoot,
      });
      if (!resolved.ok) {
        if (req.query?.allowOutsideWorkspace === 'true') {
          console.warn(`Rejected outside-workspace read: ${resolved.error}`);
        }
        return res.status(400).json({ error: resolved.error });
      }

      const [canonicalPath, canonicalBase] = await Promise.all([
        fsPromises.realpath(resolved.resolved),
        fsPromises.realpath(resolved.base).catch(() => path.resolve(resolved.base)),
      ]);

      if (!isPathWithinRoot(canonicalPath, canonicalBase, path, os)) {
        return res.status(403).json({ error: 'Access to file denied' });
      }

      const stats = await fsPromises.stat(canonicalPath);
      if (!stats.isFile()) {
        return res.status(400).json({ error: 'Specified path is not a file' });
      }

      let content = await fsPromises.readFile(canonicalPath, 'utf8');
      // Retry empty reads — concurrent writer may have truncated the file
      // between our stat and read (O_TRUNC window). If the file existed with
      // content at stat time but we read nothing, the writer hasn't finished
      // writing yet.
      if (content.length === 0 && stats.size > 0) {
        for (let attempt = 0; attempt < 3; attempt++) {
          await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
          content = await fsPromises.readFile(canonicalPath, 'utf8');
          if (content.length > 0) break;
        }
        if (content.length === 0) {
          console.warn(`Read retry exhausted for ${canonicalPath}: stat reported ${stats.size} bytes but content is empty`);
        }
      }
      return res.type('text/plain').send(content);
    } catch (error) {
      const err = error;
      if (errorCode(err) === 'ENOENT') {
        if (optional) {
          return res.type('text/plain').send('');
        }
        return res.status(404).json({ error: 'File not found' });
      }
      if (errorCode(err) === 'EACCES') {
        return res.status(403).json({ error: 'Access to file denied' });
      }
      console.error('Failed to read file:', error);
      return res.status(500).json({ error: errorMessage(error, 'Failed to read file') });
    }
  });

  app.get('/api/fs/raw', async (req, res) => {
    const filePath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
    if (!filePath) {
      return res.status(400).json({ error: 'Path is required' });
    }

    try {
      const resolved = await resolveReadPathFromContext({
        req,
        targetPath: filePath,
        scope: 'raw',
        resolveProjectDirectory,
        path,
        os,
        fsPromises,
        normalizeDirectoryPath,
        varinUserConfigRoot,
      });
      if (!resolved.ok) {
        if (req.query?.allowOutsideWorkspace === 'true') {
          console.warn(`Rejected outside-workspace raw read: ${resolved.error}`);
        }
        return res.status(400).json({ error: resolved.error });
      }

      const [canonicalPath, canonicalBase] = await Promise.all([
        fsPromises.realpath(resolved.resolved),
        fsPromises.realpath(resolved.base).catch(() => path.resolve(resolved.base)),
      ]);

      if (!isPathWithinRoot(canonicalPath, canonicalBase, path, os)) {
        return res.status(403).json({ error: 'Access to file denied' });
      }

      const stats = await fsPromises.stat(canonicalPath);
      if (!stats.isFile()) {
        return res.status(400).json({ error: 'Specified path is not a file' });
      }

      const ext = path.extname(canonicalPath).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp',
        '.ico': 'image/x-icon',
        '.bmp': 'image/bmp',
        '.avif': 'image/avif',
        '.pdf': 'application/pdf',
      };
      const mimeType = mimeMap[ext] || 'application/octet-stream';

      const download = req.query.download === 'true';
      if (download) {
        const fileName = path.basename(canonicalPath);
        // RFC 5987: use filename*= for non-ASCII filenames, with ASCII-only
        // filename= as fallback for older clients.
        const asciiOnly = [...fileName]
          .filter((character) => {
            const codePoint = character.codePointAt(0) ?? 0;
            return codePoint >= 0x20 && codePoint <= 0x7e;
          })
          .join('');
        const fallback = asciiOnly || 'file';
        // Percent-encode the raw UTF-8 bytes for filename*=
        const encoded = encodeURIComponent(fileName);
        res.setHeader('Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`);
      }

      const content = await fsPromises.readFile(canonicalPath);
      res.setHeader('Cache-Control', 'no-store');
      if (resolved.granted) {
        res.setHeader('Referrer-Policy', 'no-referrer');
      }
      return res.type(mimeType).send(content);
    } catch (error) {
      const err = error;
      if (errorCode(err) === 'ENOENT') {
        return res.status(404).json({ error: 'File not found' });
      }
      if (errorCode(err) === 'EACCES') {
        return res.status(403).json({ error: 'Access to file denied' });
      }
      console.error('Failed to read raw file:', error);
      return res.status(500).json({ error: errorMessage(error, 'Failed to read file') });
    }
  });

  app.get(/^\/api\/fs\/serve\/(.+)$/, async (req, res) => {
    const rawPath = req.params[0] || '';
    if (!rawPath) {
      return res.status(400).json({ error: 'Path is required' });
    }

    try {
      if (req.query?.allowOutsideWorkspace === 'true') {
        return res.status(403).json({ error: 'allowOutsideWorkspace is not permitted for this endpoint' });
      }

      const filePath = path.resolve('/', rawPath);
      const resolved = await resolveReadPathFromContext({
        req,
        targetPath: filePath,
        resolveProjectDirectory,
        path,
        os,
        fsPromises,
        scope: 'read',
        normalizeDirectoryPath,
        varinUserConfigRoot,
      });
      if (!resolved.ok) {
        return res.status(400).json({ error: resolved.error });
      }

      const [canonicalPath, canonicalBase] = await Promise.all([
        fsPromises.realpath(resolved.resolved),
        fsPromises.realpath(resolved.base).catch(() => path.resolve(resolved.base)),
      ]);

      if (!isPathWithinRoot(canonicalPath, canonicalBase, path, os)) {
        return res.status(403).json({ error: 'Access to file denied' });
      }

      const stats = await fsPromises.stat(canonicalPath);
      if (!stats.isFile()) {
        return res.status(400).json({ error: 'Specified path is not a file' });
      }
      if (stats.size > MAX_SERVE_BYTES) {
        return res.status(413).json({ error: 'File too large to serve' });
      }

      const ext = path.extname(canonicalPath).toLowerCase();
      const mimeType = FILE_MIME_MAP[ext] || 'application/octet-stream';
      const content = await fsPromises.readFile(canonicalPath);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.type(mimeType).send(content);
    } catch (error) {
      const err = error;
      if (errorCode(err) === 'ENOENT') {
        return res.status(404).json({ error: 'File not found' });
      }
      if (errorCode(err) === 'EACCES') {
        return res.status(403).json({ error: 'Access to file denied' });
      }
      console.error('Failed to serve file:', error);
      return res.status(500).json({ error: errorMessage(error, 'Failed to serve file') });
    }
  });

  app.post('/api/fs/write', async (req, res) => {
    const { path: filePath, content } = req.body || {};
    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json({ error: 'Path is required' });
    }
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'Content is required' });
    }

    try {
      const resolved = await resolveWorkspacePathFromContext({
        req,
        targetPath: filePath,
        resolveProjectDirectory,
        path,
        os,
        normalizeDirectoryPath,
        varinUserConfigRoot,
      });
      if (!resolved.ok) {
        return res.status(400).json({ error: resolved.error });
      }

      const writePath = await canonicalizePathIdentity(resolved.resolved, {
        allowMissing: true,
        fsPromises,
        pathModule: path,
      });
      const canonicalBase = await canonicalizePathIdentity(resolved.base, {
        fsPromises,
        pathModule: path,
      });
      if (!isPathWithinRoot(writePath, canonicalBase, path, os)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      await runWorkspaceMutation(resolved, 'fs.write', async () => {
        const kernel = await kernelFileContext(resolved);
        if (kernel && fileResources) {
          const resourceId = kernel.relativeFor(writePath);
          await fileResources.gateFor(kernel.identity).run([{ resourceId, scope: 'exact' }], async () => {
            const existing = await fsPromises.readFile(writePath, 'utf8').catch(() => null);
            if (existing === content) return;
            const captured = await fileResources.captureDetailed(
              kernel.identity,
              resourceId,
              { store: false },
              `fs-write-capture:${crypto.randomUUID()}`,
            );
            const result = await fileResources.writeBytes(
              kernel.identity,
              resourceId,
              Buffer.from(content, 'utf8'),
              {
                expected: captured.state,
                ...(captured.state.kind === 'regular-file' && captured.state.mode !== undefined
                  ? { mode: captured.state.mode }
                  : {}),
                operationId: `fs-write:${crypto.randomUUID()}`,
              },
            );
            if (result.status === 'conflict') {
              throw Object.assign(new Error('File changed during write'), { code: 'ESTALE' });
            }
          });
          return;
        }

        const existing = await fsPromises.readFile(writePath, 'utf8').catch(() => null);
        if (existing === content) return;
        await fsPromises.mkdir(path.dirname(writePath), { recursive: true });
        const tmp = `${writePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        try {
          await fsPromises.writeFile(tmp, content, 'utf8');
          await fsPromises.rename(tmp, writePath);
        } catch (error) {
          await fsPromises.unlink(tmp).catch(() => {});
          throw error;
        }
      });
      return res.json({ success: true, path: resolved.resolved });
    } catch (error) {
      const err = error;
      const authorityResponse = sendMutationAuthorityError(res, err);
      if (authorityResponse) return authorityResponse;
      if (errorCode(err) === 'ESTALE') {
        return res.status(409).json({ error: 'File changed during write' });
      }
      if (errorCode(err) === 'EACCES') {
        return res.status(403).json({ error: 'Access denied' });
      }
      console.error('Failed to write file:', error);
      return res.status(500).json({ error: errorMessage(error, 'Failed to write file') });
    }
  });

  app.post('/api/fs/delete', async (req, res) => {
    const { path: targetPath } = req.body || {};
    if (!targetPath || typeof targetPath !== 'string') {
      return res.status(400).json({ error: 'Path is required' });
    }

    try {
      const resolved = await resolveWorkspacePathFromContext({
        req,
        targetPath,
        resolveProjectDirectory,
        path,
        os,
        normalizeDirectoryPath,
        varinUserConfigRoot,
      });
      if (!resolved.ok) {
        return res.status(400).json({ error: resolved.error });
      }

      await runWorkspaceMutation(
        resolved,
        'fs.delete',
        async () => {
          const kernel = await kernelFileContext(resolved);
          if (!kernel || !fileResources) {
            await fsPromises.rm(resolved.resolved, { recursive: true, force: true });
            return;
          }
          const resourceId = kernel.relativeFor(resolved.resolved);
          await fileResources.gateFor(kernel.identity).run(
            [{ resourceId, scope: 'subtree' }],
            () => fileResources.remove(kernel.identity, resourceId, { recursive: true, force: true }),
          );
        },
      );
      return res.json({ success: true, path: resolved.resolved });
    } catch (error) {
      const err = error;
      const authorityResponse = sendMutationAuthorityError(res, err);
      if (authorityResponse) return authorityResponse;
      if (errorCode(err) === 'ENOENT') {
        return res.status(404).json({ error: 'File or directory not found' });
      }
      if (errorCode(err) === 'EACCES') {
        return res.status(403).json({ error: 'Access denied' });
      }
      console.error('Failed to delete path:', error);
      return res.status(500).json({ error: errorMessage(error, 'Failed to delete path') });
    }
  });

  app.post('/api/fs/rename', async (req, res) => {
    const { oldPath, newPath } = req.body || {};
    if (!oldPath || typeof oldPath !== 'string') {
      return res.status(400).json({ error: 'oldPath is required' });
    }
    if (!newPath || typeof newPath !== 'string') {
      return res.status(400).json({ error: 'newPath is required' });
    }

    try {
      const resolvedOld = await resolveWorkspacePathFromContext({
        req,
        targetPath: oldPath,
        resolveProjectDirectory,
        path,
        os,
        normalizeDirectoryPath,
        varinUserConfigRoot,
      });
      if (!resolvedOld.ok) {
        return res.status(400).json({ error: resolvedOld.error });
      }

      const resolvedNew = await resolveWorkspacePathFromContext({
        req,
        targetPath: newPath,
        resolveProjectDirectory,
        path,
        os,
        normalizeDirectoryPath,
        varinUserConfigRoot,
      });
      if (!resolvedNew.ok) {
        return res.status(400).json({ error: resolvedNew.error });
      }

      if (resolvedOld.base !== resolvedNew.base) {
        return res.status(400).json({ error: 'Source and destination must share the same workspace root' });
      }

      const workspaceMutation = resolvedOld.workspaceRoot && resolvedNew.workspaceRoot
        ? resolvedOld
        : null;
      await runWorkspaceMutation(
        workspaceMutation,
        'fs.rename',
        async () => {
          const kernel = await kernelFileContext(workspaceMutation);
          if (!kernel || !fileResources) {
            await fsPromises.rename(resolvedOld.resolved, resolvedNew.resolved);
            return;
          }
          const fromId = kernel.relativeFor(resolvedOld.resolved);
          const toId = kernel.relativeFor(resolvedNew.resolved);
          await fileResources.gateFor(kernel.identity).run([
            { resourceId: fromId, scope: 'subtree' },
            { resourceId: toId, scope: 'subtree' },
          ], async () => {
            const [source, target] = await Promise.all([
              fileResources.captureDetailed(kernel.identity, fromId, { store: false }, `fs-rename-source:${crypto.randomUUID()}`),
              fileResources.captureDetailed(kernel.identity, toId, { store: false }, `fs-rename-target:${crypto.randomUUID()}`),
            ]);
            const renamed = await fileResources.rename(kernel.identity, fromId, toId, {
              expectedFrom: source.state,
              expectedTo: target.state,
              operationId: `fs-rename:${crypto.randomUUID()}`,
            });
            if (renamed === 'conflict') {
              throw Object.assign(new Error('Path changed during rename'), { code: 'ESTALE' });
            }
          });
        },
      );
      return res.json({ success: true, path: resolvedNew.resolved });
    } catch (error) {
      const err = error;
      const authorityResponse = sendMutationAuthorityError(res, err);
      if (authorityResponse) return authorityResponse;
      if (errorCode(err) === 'ESTALE') {
        return res.status(409).json({ error: 'Path changed during rename' });
      }
      if (errorCode(err) === 'ENOENT') {
        return res.status(404).json({ error: 'Source path not found' });
      }
      if (errorCode(err) === 'EACCES') {
        return res.status(403).json({ error: 'Access denied' });
      }
      console.error('Failed to rename path:', error);
      return res.status(500).json({ error: errorMessage(error, 'Failed to rename path') });
    }
  });

  app.post('/api/fs/reveal', async (req, res) => {
    const { path: targetPath } = req.body || {};
    if (!targetPath || typeof targetPath !== 'string') {
      return res.status(400).json({ error: 'Path is required' });
    }

    try {
      const resolved = path.resolve(targetPath.trim());
      await fsPromises.access(resolved);

      if (platform === 'darwin') {
        const stat = await fsPromises.stat(resolved);
        if (stat.isDirectory()) {
          await spawnDetached('open', [resolved]);
        } else {
          await spawnDetached('open', ['-R', resolved]);
        }
      } else if (platform === 'win32') {
        const stat = await fsPromises.stat(resolved);
        const escapedPath = resolved.replace(/'/g, "''");
        const explorerArg = stat.isDirectory() ? escapedPath : `/select,${escapedPath}`;
        const command = `Start-Process -FilePath explorer.exe -ArgumentList '${explorerArg}'`;
        await new Promise<void>((resolve, reject) => {
          const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
            windowsHide: true,
            stdio: 'ignore',
          });
          child.once('error', reject);
          child.once('exit', (code) => {
            if (code === 0) {
              resolve();
              return;
            }
            reject(new Error(`Explorer launch failed with code ${code ?? 'unknown'}`));
          });
        });
      } else {
        const stat = await fsPromises.stat(resolved);
        const dir = stat.isDirectory() ? resolved : path.dirname(resolved);
        await spawnDetached('xdg-open', [dir]);
      }

      return res.json({ success: true, path: resolved });
    } catch (error) {
      const err = error;
      if (errorCode(err) === 'ENOENT') {
        return res.status(404).json({ error: 'Path not found' });
      }
      console.error('Failed to reveal path:', error);
      return res.status(500).json({ error: errorMessage(error, 'Failed to reveal path') });
    }
  });

  app.post('/api/fs/exec', async (req, res) => {
    const { commands, cwd, background } = req.body || {};
    if (!Array.isArray(commands) || commands.length === 0) {
      return res.status(400).json({ error: 'Commands array is required' });
    }
    if (!cwd || typeof cwd !== 'string') {
      return res.status(400).json({ error: 'Working directory (cwd) is required' });
    }

    pruneExecJobs();
    pruneGitReadCache();

    try {
      if (background === true) {
        console.warn('Rejected background /api/fs/exec request');
        return res.status(400).json({ error: 'Background command execution is not allowed' });
      }
      const resolvedCwdCandidate = path.resolve(normalizeDirectoryPath(cwd));
      const resolvedForWorkspace = await resolveWorkspacePathFromContext({
        req,
        targetPath: resolvedCwdCandidate,
        resolveProjectDirectory,
        path,
        os,
        normalizeDirectoryPath,
        varinUserConfigRoot,
      });
      if (!resolvedForWorkspace.ok) {
        console.warn(`Rejected /api/fs/exec outside workspace: ${resolvedForWorkspace.error}`);
        return res.status(403).json({ error: resolvedForWorkspace.error });
      }
      const resolvedCwd = resolvedForWorkspace.resolved;
      const stats = await fsPromises.stat(resolvedCwd);
      if (!stats.isDirectory()) {
        return res.status(400).json({ error: 'Specified cwd is not a directory' });
      }

      const shell = process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
      const shellFlag = process.platform === 'win32' ? '/c' : '-c';

      const jobId = crypto.randomUUID();
      const job: ExecJob = {
        jobId,
        status: 'queued',
        success: null,
        commands,
        resolvedCwd,
        shell,
        shellFlag,
        results: [],
        startedAt: Date.now(),
        finishedAt: null,
        updatedAt: Date.now(),
      };

      execJobs.set(jobId, job);

      const isBackground = false;
      if (isBackground) {
        void runExecJob(job).catch((error) => {
          job.status = 'done';
          job.success = false;
          job.results = Array.isArray(job.results) ? job.results : [];
          job.results.push({
            command: '',
            success: false,
            error: errorMessage(error, 'Command execution failed'),
            stdout: '',
            stderr: '',
          });
          job.finishedAt = Date.now();
          job.updatedAt = Date.now();
        });

        return res.status(202).json({
          jobId,
          status: 'running',
        });
      }

      await runWorkspaceMutation(
        resolvedForWorkspace,
        `fs.exec:${jobId}`,
        () => runExecJob(job),
        { mode: 'process', purpose: 'fs-exec' },
      );
      return res.json({
        jobId,
        status: job.status,
        success: job.success === true,
        results: job.results,
      });
    } catch (error) {
      const authorityResponse = sendMutationAuthorityError(res, error);
      if (authorityResponse) return authorityResponse;
      console.error('Failed to execute commands:', error);
      return res.status(500).json({ error: errorMessage(error, 'Failed to execute commands') });
    }
  });

  app.get('/api/fs/exec/:jobId', (req, res) => {
    const jobId = typeof req.params?.jobId === 'string' ? req.params.jobId : '';
    if (!jobId) {
      return res.status(400).json({ error: 'Job id is required' });
    }

    pruneExecJobs();

    const job = execJobs.get(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    job.updatedAt = Date.now();
    return res.json({
      jobId: job.jobId,
      status: job.status,
      success: job.success === true,
      results: Array.isArray(job.results) ? job.results : [],
    });
  });

  app.get('/api/fs/list', async (req, res) => {
    const rawPath = typeof req.query.path === 'string' && req.query.path.trim().length > 0
      ? req.query.path.trim()
      : os.homedir();
    const respectGitignore = req.query.respectGitignore === 'true';
    let requestedPath = '';
    let resolvedPath = '';

    try {
      requestedPath = path.resolve(normalizeDirectoryPath(rawPath));
      resolvedPath = await realpathCache.resolve(requestedPath);

      const stats = await fsPromises.stat(resolvedPath);
      if (!stats.isDirectory()) {
        return res.status(400).json({ error: 'Specified path is not a directory', reason: 'not-directory' });
      }

      const dirents = await fsPromises.readdir(resolvedPath, { withFileTypes: true });
      const ignoredPaths = new Set<string>();
      if (respectGitignore) {
        try {
          const pathsToCheck = dirents.map((d) => d.name);
          if (pathsToCheck.length > 0) {
            try {
              const result = await new Promise<string>((resolve) => {
                const child = spawn(resolveGitBinaryForSpawn(), ['check-ignore', '--', ...pathsToCheck], {
                  cwd: resolvedPath,
                  windowsHide: true,
                  stdio: ['ignore', 'pipe', 'pipe'],
                });

                let stdout = '';
                let settled = false;
                let timeout: ReturnType<typeof setTimeout> | null = null;
                const finish = (value: string): void => {
                  if (settled) return;
                  settled = true;
                  if (timeout) clearTimeout(timeout);
                  resolve(value);
                };

                if (gitCheckIgnoreTimeoutMs > 0) {
                  timeout = setTimeout(() => {
                    try {
                      child.kill('SIGKILL');
                    } catch {
                      // The check-ignore process may already have exited.
                    }
                    finish('');
                  }, gitCheckIgnoreTimeoutMs);
                }

                child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
                child.on('close', () => finish(stdout));
                child.on('error', () => finish(''));
              });

              result.split('\n').filter(Boolean).forEach((name) => {
                const fullPath = path.join(resolvedPath, name.trim());
                ignoredPaths.add(fullPath);
              });
            } catch {
              // Git ignore filtering is best-effort; list all entries on failure.
            }
          }
        } catch {
          // Git ignore filtering is best-effort; list all entries on failure.
        }
      }

      const entries = await Promise.all(
        dirents.map(async (dirent) => {
          const physicalEntryPath = path.join(resolvedPath, dirent.name);
          if (respectGitignore && ignoredPaths.has(physicalEntryPath)) {
            return null;
          }

          let isDirectory = dirent.isDirectory();
          const isSymbolicLink = dirent.isSymbolicLink();

          if (!isDirectory && isSymbolicLink) {
            try {
              const linkStats = await fsPromises.stat(physicalEntryPath);
              isDirectory = linkStats.isDirectory();
            } catch {
              isDirectory = false;
            }
          }

          return {
            name: dirent.name,
            path: path.join(requestedPath, dirent.name),
            isDirectory,
            isFile: dirent.isFile(),
            isSymbolicLink,
          };
        })
      );

      return res.json({
        path: requestedPath,
        entries: entries.filter(Boolean),
      });
    } catch (error) {
      const err = error;
      const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
      if (code !== 'ENOENT') {
        console.error('Failed to list directory:', error);
      }
      if (code === 'ENOENT') {
        return res.status(404).json({ error: 'Directory not found', reason: 'not-found' });
      }
      if (isOsPermissionError(err)) {
        return res.status(403).json({ error: 'Access to directory denied', reason: 'os-permission' });
      }
      return res.status(500).json({ error: errorMessage(error, 'Failed to list directory') });
    }
  });
};
