import type { spawn as spawnFunction } from 'node:child_process';
import type { Stats } from 'node:fs';
import type fsPromisesModule from 'node:fs/promises';
import type pathModule from 'node:path';
import type { Express, Request, Response } from 'express';
import type { DocumentAuthority } from '../documents/authority.js';
import type { VarinAuthenticatedClient } from '../client-auth/request-context.js';

const FULL_CONTROL_PROFILES = new Set(['full-control', 'external-agent', 'rescue']);
const MAX_READ_BYTES = 10 * 1024 * 1024;
const MAX_LIST_ENTRIES = 5000;
const MAX_COMMAND_BYTES = 2 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_MS = 10 * 60_000;

const EXTERNAL_CAPABILITIES = Object.freeze([
  'external-access.v1',
  'external-roots.v1',
  'external-fs.v1',
  'external-command.v1',
  'external-audit.v1',
]);

type FsPromises = typeof fsPromisesModule;
type PathModule = typeof pathModule;
type Spawn = typeof spawnFunction;

interface ExternalRootDefinition {
  id: string;
  label: string;
  path: string;
  source: string;
}

type ExternalRootStatus = ExternalRootDefinition & (
  | { error: string; exists: false; type: null }
  | { exists: true; mtimeMs: number; type: 'directory' | 'file' | 'other' }
);

interface ResolvedRoot extends ExternalRootDefinition {
  exists: true;
  mtimeMs: number;
  realPath: string;
  type: 'directory';
}

interface ResolvedExternalPath {
  absolutePath: string;
  relativePath: string;
  root: ResolvedRoot;
}

interface ExternalRootRuntimeOptions {
  __dirname: string;
  deploymentRoot?: string;
  fsPromises: FsPromises;
  path: PathModule;
  varinDataDir: string;
  process: NodeJS.Process;
  resolveProjectDirectory?: (req: Request) => Promise<{ directory?: string | null }>;
}

interface ExternalAccessDependencies extends ExternalRootRuntimeOptions {
  buildAugmentedPath?: (basePath: string) => string;
  documents?: Pick<DocumentAuthority, 'runMutationForScope'>;
  varinVersion: string;
  remoteClientAuthRuntime?: { listAuditEvents(input: { limit?: unknown }): Promise<unknown[]> };
  runtimeName?: string;
  serverStartedAt?: string;
  spawn: Spawn;
}

interface DirectoryEntry {
  children?: DirectoryEntry[];
  mtimeMs: number;
  name: string;
  path: string;
  size: number;
  type: 'directory' | 'file' | 'other' | 'symlink';
}

interface CommandResult {
  error?: string;
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  stderr: string;
  stderrTruncated: boolean;
  stdout: string;
  stdoutTruncated: boolean;
  success: boolean;
  timedOut?: boolean;
}

const errorRecord = (error: unknown): Record<string, unknown> => (
  error && typeof error === 'object' ? error as Record<string, unknown> : {}
);

const errorCode = (error: unknown): string | null => {
  const code = errorRecord(error).code;
  return typeof code === 'string' ? code : null;
};

const errorMessage = (error: unknown, fallback: string): string => (
  error instanceof Error && error.message ? error.message : fallback
);

const httpError = (message: string, statusCode: number): Error & { statusCode: number } => (
  Object.assign(new Error(message), { statusCode })
);

const toPosixPath = (value: unknown): string => String(value || '').replace(/\\/g, '/');

const normalizeRootId = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
};

const normalizeRelativePath = (value: unknown, pathModule: PathModule): string | null => {
  if (typeof value !== 'string' || value.trim().length === 0) return '.';
  const trimmed = value.trim();
  if (pathModule.isAbsolute(trimmed)) return null;
  return trimmed;
};

const isPathWithinRoot = (candidate: string, rootPath: string, pathModule: PathModule): boolean => {
  const relative = pathModule.relative(rootPath, candidate);
  return relative === '' || (!relative.startsWith('..') && !pathModule.isAbsolute(relative));
};

const accessOk = async (fsPromises: FsPromises, targetPath: string): Promise<boolean> => {
  try {
    await fsPromises.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const realpathOrResolve = async (fsPromises: FsPromises, pathModule: PathModule, targetPath: string): Promise<string> => {
  try {
    return await fsPromises.realpath(targetPath);
  } catch {
    return pathModule.resolve(targetPath);
  }
};

const resolveExistingAncestor = async (fsPromises: FsPromises, pathModule: PathModule, targetPath: string) => {
  let current = pathModule.resolve(targetPath);
  while (current) {
    try {
      const realPath = await fsPromises.realpath(current);
      return { path: current, realPath };
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      const parent = pathModule.dirname(current);
      if (!parent || parent === current) throw error;
      current = parent;
    }
  }
  throw httpError('No existing parent directory found', 404);
};

const findDeploymentRoot = async ({ fsPromises, pathModule, startPaths }: {
  fsPromises: FsPromises;
  pathModule: PathModule;
  startPaths: string[];
}): Promise<string | null> => {
  const seen = new Set<string>();
  for (const startPath of startPaths) {
    if (typeof startPath !== 'string' || !startPath.trim()) continue;
    let current = pathModule.resolve(startPath);
    try {
      const stats = await fsPromises.stat(current);
      if (stats.isFile()) current = pathModule.dirname(current);
    } catch {
      // Keep walking from the resolved path; it may be an install root that
      // does not exist in tests.
    }

    while (current && !seen.has(current)) {
      seen.add(current);
      const packageJsonPath = pathModule.join(current, 'package.json');
      const webPackagePath = pathModule.join(current, 'packages', 'web', 'package.json');
      const gitPath = pathModule.join(current, '.git');
      if (
        await accessOk(fsPromises, packageJsonPath) &&
        (await accessOk(fsPromises, webPackagePath) || await accessOk(fsPromises, gitPath))
      ) {
        return realpathOrResolve(fsPromises, pathModule, current);
      }

      const parent = pathModule.dirname(current);
      if (!parent || parent === current) break;
      current = parent;
    }
  }

  return null;
};

const statRoot = async (fsPromises: FsPromises, root: ExternalRootDefinition): Promise<ExternalRootStatus> => {
  try {
    const stats = await fsPromises.stat(root.path);
    return {
      ...root,
      exists: true,
      type: stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other',
      mtimeMs: stats.mtimeMs,
    };
  } catch (error) {
    return {
      ...root,
      exists: false,
      type: null,
      error: errorMessage(error, 'Root is unavailable'),
    };
  }
};

const uniqueRoots = (roots: ExternalRootDefinition[], pathModule: PathModule): ExternalRootDefinition[] => {
  const byId = new Set<string>();
  const byPath = new Set<string>();
  const result: ExternalRootDefinition[] = [];
  for (const root of roots) {
    if (!root?.id || !root?.path) continue;
    const id = normalizeRootId(root.id);
    const resolvedPath = pathModule.resolve(root.path);
    const key = resolvedPath.toLowerCase();
    if (byId.has(id) || byPath.has(key)) continue;
    byId.add(id);
    byPath.add(key);
    result.push({ ...root, id, path: resolvedPath });
  }
  return result;
};

const getClient = (req: Request): VarinAuthenticatedClient | null => req.varinAuth?.client || null;

const getClientCapabilities = (client: VarinAuthenticatedClient | null): Set<string> => new Set(
  Array.isArray(client?.capabilities)
    ? client.capabilities.filter((entry) => typeof entry === 'string')
    : []
);

const hasCapability = (req: Request, capability: string): boolean => {
  const context = req.varinAuth;
  if (context?.type === 'session') return true;
  if (context?.type !== 'client') return false;
  const client = getClient(req);
  const profile = typeof client?.profile === 'string' ? client.profile : '';
  if (FULL_CONTROL_PROFILES.has(profile)) return true;
  const capabilities = getClientCapabilities(client);
  return capabilities.has('*') ||
    capabilities.has('admin') ||
    capabilities.has(capability) ||
    capabilities.has(capability.replace(/:[^:]+$/, ':*'));
};

const requireCapability = (req: Request, res: Response, capability: string): boolean => {
  if (!req.varinAuth) {
    res.status(401).json({ error: 'Authentication required' });
    return false;
  }
  if (!hasCapability(req, capability)) {
    res.status(403).json({ error: `External client is missing ${capability}` });
    return false;
  }
  return true;
};

const sendError = (res: Response, error: unknown) => {
  const record = errorRecord(error);
  const code = errorCode(error);
  const status = typeof record.statusCode === 'number' && Number.isInteger(record.statusCode)
    ? record.statusCode
    : code === 'ENOENT'
      ? 404
      : code === 'EACCES' || code === 'EPERM'
        ? 403
        : 500;
  if (status >= 500) {
    console.error('[external-access] request failed:', error);
  }
  return res.status(status).json({ error: errorMessage(error, 'External access request failed') });
};

export const createExternalAccessRootRuntime = ({
  fsPromises,
  path,
  process,
  __dirname,
  varinDataDir,
  resolveProjectDirectory,
  deploymentRoot,
}: ExternalRootRuntimeOptions) => {
  const resolveRoots = async (req: Request): Promise<ExternalRootStatus[]> => {
    const envDeploymentRoot = typeof process.env.VARIN_DEPLOYMENT_ROOT === 'string'
      ? process.env.VARIN_DEPLOYMENT_ROOT.trim()
      : '';
    const serverPackageRoot = path.resolve(__dirname, '..');
    const discoveredDeploymentRoot = deploymentRoot
      || envDeploymentRoot
      || await findDeploymentRoot({
        fsPromises,
        pathModule: path,
        startPaths: [process.cwd(), __dirname, serverPackageRoot],
      })
      || process.cwd();

    const roots: ExternalRootDefinition[] = [
      { id: 'deployment', label: 'Varin deployment', path: discoveredDeploymentRoot, source: 'deployment' },
      { id: 'server-package', label: 'Varin web package', path: serverPackageRoot, source: 'server-package' },
      { id: 'process-cwd', label: 'Server working directory', path: process.cwd(), source: 'process' },
      { id: 'data', label: 'Varin data', path: varinDataDir, source: 'data' },
      { id: 'logs', label: 'Varin logs', path: path.join(varinDataDir, 'logs'), source: 'logs' },
    ];

    if (typeof resolveProjectDirectory === 'function') {
      const project = await resolveProjectDirectory(req).catch(() => null);
      if (project?.directory) {
        roots.unshift({ id: 'workspace', label: 'Active workspace', path: project.directory, source: 'workspace' });
      }
    }

    const client = getClient(req);
    const allowedDirectories = Array.isArray(client?.allowedDirectories) ? client.allowedDirectories : [];
    allowedDirectories.forEach((directory, index) => {
      roots.push({
        id: `client-${index + 1}`,
        label: `Client root ${index + 1}`,
        path: directory,
        source: 'client',
      });
    });

    return Promise.all(uniqueRoots(roots, path).map((root) => statRoot(fsPromises, root)));
  };

  const getRoot = async (req: Request, rootId: unknown): Promise<ResolvedRoot> => {
    const id = normalizeRootId(rootId || 'deployment');
    const roots = await resolveRoots(req);
    const root = roots.find((entry) => entry.id === id);
    if (!root) {
      throw httpError(`Unknown external root: ${id || '<empty>'}`, 404);
    }
    if (!root.exists || root.type !== 'directory') {
      throw httpError('error' in root ? root.error : `External root is unavailable: ${id}`, 404);
    }
    const realPath = await realpathOrResolve(fsPromises, path, root.path);
    return { ...root, exists: true, type: 'directory', realPath };
  };

  const resolvePath = async (req: Request, { rootId, relativePath, mustExist = false, forWrite = false }: {
    forWrite?: boolean;
    mustExist?: boolean;
    relativePath?: unknown;
    rootId?: unknown;
  }): Promise<ResolvedExternalPath> => {
    const root = await getRoot(req, rootId);
    const normalizedRelativePath = normalizeRelativePath(relativePath, path);
    if (normalizedRelativePath === null) {
      throw httpError('Path must be relative to the selected root', 400);
    }
    const candidate = path.resolve(root.realPath, normalizedRelativePath);
    if (!isPathWithinRoot(candidate, root.realPath, path)) {
      throw httpError('Path is outside the selected root', 403);
    }

    if (mustExist) {
      const canonical = await fsPromises.realpath(candidate);
      if (!isPathWithinRoot(canonical, root.realPath, path)) {
        throw httpError('Path resolves outside the selected root', 403);
      }
      return { root, absolutePath: canonical, relativePath: toPosixPath(path.relative(root.realPath, canonical)) || '.' };
    }

    if (forWrite) {
      const ancestor = await resolveExistingAncestor(fsPromises, path, candidate);
      if (!isPathWithinRoot(ancestor.realPath, root.realPath, path)) {
        throw httpError('Write target resolves outside the selected root', 403);
      }
      if (ancestor.path === candidate) {
        const targetRealPath = await fsPromises.realpath(candidate);
        if (!isPathWithinRoot(targetRealPath, root.realPath, path)) {
          throw httpError('Write target resolves outside the selected root', 403);
        }
      }
    }

    return { root, absolutePath: candidate, relativePath: toPosixPath(path.relative(root.realPath, candidate)) || '.' };
  };

  return {
    resolveRoots,
    resolvePath,
  };
};

const entryType = (stats: Stats): DirectoryEntry['type'] => stats.isDirectory()
  ? 'directory'
  : stats.isFile()
    ? 'file'
    : stats.isSymbolicLink()
      ? 'symlink'
      : 'other';

const listDirectory = async ({ fsPromises, path, root, absolutePath, depth, state }: {
  absolutePath: string;
  depth: number;
  fsPromises: FsPromises;
  path: PathModule;
  root: ResolvedRoot;
  state: { count: number };
}): Promise<DirectoryEntry[]> => {
  if (state.count >= MAX_LIST_ENTRIES) return [];
  const dirents = await fsPromises.readdir(absolutePath, { withFileTypes: true });
  const entries: DirectoryEntry[] = [];
  for (const dirent of dirents) {
    if (state.count >= MAX_LIST_ENTRIES) break;
    const childPath = path.join(absolutePath, dirent.name);
    let stats;
    try {
      stats = await fsPromises.lstat(childPath);
    } catch {
      continue;
    }
    state.count += 1;
    const relative = toPosixPath(path.relative(root.realPath, childPath));
    const entry: DirectoryEntry = {
      name: dirent.name,
      path: relative,
      type: entryType(stats),
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    };
    if (depth > 0 && stats.isDirectory()) {
      entry.children = await listDirectory({
        fsPromises,
        path,
        root,
        absolutePath: childPath,
        depth: depth - 1,
        state,
      });
    }
    entries.push(entry);
  }
  return entries;
};

const readFileContent = async ({ fsPromises, absolutePath, encoding }: {
  absolutePath: string;
  encoding: 'base64' | 'utf8';
  fsPromises: FsPromises;
}) => {
  const buffer = await fsPromises.readFile(absolutePath);
  if (buffer.byteLength > MAX_READ_BYTES) {
    throw httpError(`File is too large to read through external access (${buffer.byteLength} bytes)`, 413);
  }
  if (encoding === 'base64') {
    return { encoding: 'base64', content: buffer.toString('base64') };
  }
  return { encoding: 'utf8', content: buffer.toString('utf8') };
};

const normalizeTimeoutMs = (value: unknown): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_COMMAND_TIMEOUT_MS;
  return Math.min(Math.max(parsed, 1000), MAX_COMMAND_TIMEOUT_MS);
};

const truncateOutput = (value: string) => {
  if (Buffer.byteLength(value, 'utf8') <= MAX_COMMAND_BYTES) {
    return { value, truncated: false };
  }
  return {
    value: Buffer.from(value).subarray(0, MAX_COMMAND_BYTES).toString('utf8'),
    truncated: true,
  };
};

const runCommand = ({ spawn, command, cwd, timeoutMs, env }: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawn: Spawn;
  timeoutMs: number;
}): Promise<CommandResult> => new Promise((resolve) => {
  const isWin = process.platform === 'win32';
  const shell = isWin ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/sh');
  const args = isWin ? ['/d', '/s', '/c', command] : ['-lc', command];
  let stdout = '';
  let stderr = '';
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let timedOut = false;
  const child = spawn(shell, args, {
    cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill('SIGKILL');
    } catch {
      // The process may have exited between the timeout and the kill request.
    }
  }, timeoutMs);

  child.stdout?.on('data', (chunk: Buffer | string) => {
    if (stdoutTruncated) return;
    const next = stdout + chunk.toString();
    const truncated = truncateOutput(next);
    stdout = truncated.value;
    stdoutTruncated = truncated.truncated;
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    if (stderrTruncated) return;
    const next = stderr + chunk.toString();
    const truncated = truncateOutput(next);
    stderr = truncated.value;
    stderrTruncated = truncated.truncated;
  });
  child.on('error', (error) => {
    clearTimeout(timeout);
    resolve({
      success: false,
      exitCode: null,
      stdout,
      stderr,
      stdoutTruncated,
      stderrTruncated,
      error: errorMessage(error, 'Command failed to start'),
    });
  });
  child.on('close', (code, signal) => {
    clearTimeout(timeout);
    resolve({
      success: code === 0 && !timedOut,
      exitCode: Number.isInteger(code) ? code : null,
      signal: signal || null,
      stdout,
      stderr,
      stdoutTruncated,
      stderrTruncated,
      timedOut,
      ...(timedOut ? { error: `Command timed out after ${timeoutMs}ms` } : {}),
    });
  });
});

export const registerExternalAccessRoutes = (app: Express, dependencies: ExternalAccessDependencies): void => {
  const {
    fsPromises,
    path,
      process,
    spawn,
    buildAugmentedPath,
    varinDataDir,
    varinVersion,
    runtimeName,
    serverStartedAt,
    remoteClientAuthRuntime,
    resolveProjectDirectory,
    __dirname,
    deploymentRoot,
    documents,
  } = dependencies;

  const rootRuntime = createExternalAccessRootRuntime({
    fsPromises,
    path,
      process,
    __dirname,
    varinDataDir,
    ...(resolveProjectDirectory ? { resolveProjectDirectory } : {}),
    ...(deploymentRoot ? { deploymentRoot } : {}),
  });

  const runWorkspaceMutation = <Result>(
    resolved: ResolvedExternalPath,
    ownerId: string,
    operation: () => Promise<Result>,
    options: Record<string, unknown> = {},
  ): Promise<Result> => {
    if (resolved?.root?.source !== 'workspace' || typeof documents?.runMutationForScope !== 'function') {
      return operation();
    }
    const scope = options.resourceScope === 'subtree' ? 'subtree' : 'exact';
    const { resourceScope: _resourceScope, ...writerOptions } = options;
    return documents.runMutationForScope(
      resolved.root.realPath,
      { kind: 'web-route', id: ownerId },
      operation,
      {
        ...writerOptions,
        resourceOperations: [{ resourceId: resolved.relativePath, scope }],
      },
    );
  };

  app.get('/api/external/me', (req, res) => {
    const context = req.varinAuth || null;
    if (!context) return res.status(401).json({ error: 'Authentication required' });
    return res.json({
      type: context.type,
      clientId: context.clientId || context.client?.id || null,
      client: context.client || null,
    });
  });

  app.get('/api/external/capabilities', (req, res) => {
    const context = req.varinAuth || null;
    if (!context) return res.status(401).json({ error: 'Authentication required' });
    const client = context.client || null;
    res.json({
      capabilities: EXTERNAL_CAPABILITIES,
      auth: {
        type: context.type,
        clientId: context.clientId || client?.id || null,
        profile: client?.profile || null,
        capabilities: Array.isArray(client?.capabilities) ? client.capabilities : [],
      },
      routes: [
        'GET /api/external/me',
        'GET /api/external/capabilities',
        'GET /api/external/status',
        'GET /api/external/roots',
        'GET /api/external/fs/list',
        'GET /api/external/fs/read',
        'PUT /api/external/fs/write',
        'POST /api/external/fs/folder',
        'DELETE /api/external/fs/entry',
        'POST /api/external/command',
        'GET /api/external/audit',
      ],
    });
  });

  app.get('/api/external/status', async (req, res) => {
    if (!requireCapability(req, res, 'instance:read')) return;
    try {
      res.json({
        varinVersion,
        runtime: runtimeName || 'web',
        startedAt: serverStartedAt || null,
        pid: process.pid,
        platform: process.platform,
        arch: process.arch,
        cwd: process.cwd(),
        dataDir: varinDataDir,
        node: process.version,
        uptimeSeconds: Math.round(process.uptime()),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/external/roots', async (req, res) => {
    if (!requireCapability(req, res, 'filesystem:read')) return;
    try {
      res.json({ roots: await rootRuntime.resolveRoots(req) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/external/fs/list', async (req, res) => {
    if (!requireCapability(req, res, 'filesystem:read')) return;
    try {
      const rootId = req.query?.root || 'deployment';
      const relativePath = req.query?.path || '.';
      const depthRaw = Number.parseInt(String(req.query?.depth ?? '0'), 10);
      const depth = Number.isFinite(depthRaw) ? Math.min(Math.max(depthRaw, 0), 6) : 0;
      const resolved = await rootRuntime.resolvePath(req, { rootId, relativePath, mustExist: true });
      const stats = await fsPromises.stat(resolved.absolutePath);
      if (!stats.isDirectory()) {
        return res.status(400).json({ error: 'Path is not a directory' });
      }
      const state = { count: 0 };
      const entries = await listDirectory({
        fsPromises,
        path,
        root: resolved.root,
        absolutePath: resolved.absolutePath,
        depth,
        state,
      });
      return res.json({
        root: resolved.root.id,
        path: resolved.relativePath,
        absolutePath: resolved.absolutePath,
        entries,
        truncated: state.count >= MAX_LIST_ENTRIES,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get('/api/external/fs/read', async (req, res) => {
    if (!requireCapability(req, res, 'filesystem:read')) return;
    try {
      const resolved = await rootRuntime.resolvePath(req, {
        rootId: req.query?.root || 'deployment',
        relativePath: req.query?.path || '.',
        mustExist: true,
      });
      const stats = await fsPromises.stat(resolved.absolutePath);
      if (!stats.isFile()) {
        return res.status(400).json({ error: 'Path is not a file' });
      }
      const content = await readFileContent({
        fsPromises,
        absolutePath: resolved.absolutePath,
        encoding: req.query?.encoding === 'base64' ? 'base64' : 'utf8',
      });
      return res.json({
        root: resolved.root.id,
        path: resolved.relativePath,
        absolutePath: resolved.absolutePath,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        ...content,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.put('/api/external/fs/write', async (req, res) => {
    if (!requireCapability(req, res, 'filesystem:write')) return;
    try {
      const body = req.body || {};
      const rootId = body.root || 'deployment';
      const relativePath = body.path || '.';
      if (typeof body.content !== 'string') {
        return res.status(400).json({ error: 'content must be a string' });
      }
      const candidate = await rootRuntime.resolvePath(req, { rootId, relativePath, mustExist: false });
      const resolved = await rootRuntime.resolvePath(req, { rootId, relativePath, mustExist: false, forWrite: true });
      const result = await runWorkspaceMutation<{ conflict: true } | { conflict: false; stats: Stats }>(resolved, 'external.fs.write', async () => {
        if (body.createParents !== false) {
          await fsPromises.mkdir(path.dirname(candidate.absolutePath), { recursive: true });
        }
        const expectedMtimeMs = typeof body.expectedMtimeMs === 'number' ? body.expectedMtimeMs : null;
        if (expectedMtimeMs !== null) {
          try {
            const current = await fsPromises.stat(resolved.absolutePath);
            if (Math.abs(current.mtimeMs - expectedMtimeMs) > 1) {
              return { conflict: true };
            }
          } catch (error) {
            if (errorCode(error) !== 'ENOENT') throw error;
          }
        }
        const buffer = body.encoding === 'base64'
          ? Buffer.from(body.content, 'base64')
          : Buffer.from(body.content, 'utf8');
        await fsPromises.writeFile(resolved.absolutePath, buffer);
        const stats = await fsPromises.stat(resolved.absolutePath);
        return { conflict: false, stats };
      }, { mode: 'external', purpose: 'external-fs-write' });
      if (result.conflict) {
        return res.status(409).json({ error: 'File was modified after it was read' });
      }
      const stats = result.stats;
      return res.json({
        success: true,
        root: resolved.root.id,
        path: resolved.relativePath,
        absolutePath: resolved.absolutePath,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/external/fs/folder', async (req, res) => {
    if (!requireCapability(req, res, 'filesystem:write')) return;
    try {
      const resolved = await rootRuntime.resolvePath(req, {
        rootId: req.body?.root || 'deployment',
        relativePath: req.body?.path || '.',
        mustExist: false,
        forWrite: true,
      });
      const canonical = await runWorkspaceMutation(resolved, 'external.fs.folder', async () => {
        await fsPromises.mkdir(resolved.absolutePath, { recursive: true });
        return rootRuntime.resolvePath(req, {
          rootId: req.body?.root || 'deployment',
          relativePath: req.body?.path || '.',
          mustExist: true,
        });
      }, { mode: 'external', purpose: 'external-fs-folder', resourceScope: 'subtree' });
      return res.json({
        success: true,
        root: canonical.root.id,
        path: canonical.relativePath,
        absolutePath: canonical.absolutePath,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.delete('/api/external/fs/entry', async (req, res) => {
    if (!requireCapability(req, res, 'filesystem:delete')) return;
    try {
      const rootId = req.body?.root || req.query?.root || 'deployment';
      const relativePath = req.body?.path || req.query?.path || '';
      const normalizedRelativePath = normalizeRelativePath(relativePath, path);
      if (!normalizedRelativePath || normalizedRelativePath === '.') {
        return res.status(400).json({ error: 'Refusing to delete an external root directly' });
      }
      const resolved = await rootRuntime.resolvePath(req, { rootId, relativePath, mustExist: true });
      const stats = await fsPromises.lstat(resolved.absolutePath);
      const recursive = req.body?.recursive === true || req.query?.recursive === 'true';
      if (stats.isDirectory() && !recursive) {
        return res.status(400).json({ error: 'recursive=true is required to delete directories' });
      }
      await runWorkspaceMutation(
        resolved,
        'external.fs.delete',
        () => fsPromises.rm(resolved.absolutePath, { recursive, force: false }),
        { mode: 'external', purpose: 'external-fs-delete', resourceScope: 'subtree' },
      );
      return res.json({
        success: true,
        root: resolved.root.id,
        path: resolved.relativePath,
        absolutePath: resolved.absolutePath,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/external/command', async (req, res) => {
    if (!requireCapability(req, res, 'terminal:use')) return;
    try {
      const command = typeof req.body?.command === 'string' ? req.body.command.trim() : '';
      if (!command) {
        return res.status(400).json({ error: 'command is required' });
      }
      if (command.length > 12_000) {
        return res.status(413).json({ error: 'command is too large' });
      }
      const rootId = req.body?.root || 'deployment';
      const cwdPath = req.body?.cwd || '.';
      const resolved = await rootRuntime.resolvePath(req, {
        rootId,
        relativePath: cwdPath,
        mustExist: true,
      });
      const stats = await fsPromises.stat(resolved.absolutePath);
      if (!stats.isDirectory()) {
        return res.status(400).json({ error: 'cwd is not a directory' });
      }
      const timeoutMs = normalizeTimeoutMs(req.body?.timeoutMs);
      const envPath = typeof buildAugmentedPath === 'function'
        ? buildAugmentedPath(process.env.PATH || '')
        : process.env.PATH;
      const result = await runWorkspaceMutation(
        resolved,
        'external.command',
        () => runCommand({
          spawn,
          command,
          cwd: resolved.absolutePath,
          timeoutMs,
          env: { ...process.env, PATH: envPath },
        }),
        { mode: 'process', purpose: 'external-command' },
      );
      return res.json({
        ...result,
        root: resolved.root.id,
        cwd: resolved.relativePath,
        absoluteCwd: resolved.absolutePath,
        timeoutMs,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get('/api/external/audit', async (req, res) => {
    if (!requireCapability(req, res, 'instance:read')) return;
    try {
      const events = typeof remoteClientAuthRuntime?.listAuditEvents === 'function'
        ? await remoteClientAuthRuntime.listAuditEvents({ limit: req.query?.limit })
        : [];
      return res.json({ events });
    } catch (error) {
      return sendError(res, error);
    }
  });
};
