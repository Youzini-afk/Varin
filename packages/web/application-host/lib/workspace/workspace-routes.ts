import fs from 'fs';
import type { Express, Request, Response } from 'express';
import multer from 'multer';
import os from 'os';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { projectFolders, projectPathKey } from '@varin/application-client';
import { createWorkspaceConfig } from './workspace-config.js';
import { resolveWorkspacePath } from './path-safety.js';
import {
  extractWorkspaceArchive,
  previewWorkspaceArchive,
} from './archive.js';
import {
  createWorkspaceFile,
  createWorkspaceFolder,
  deleteWorkspaceEntry,
  getWorkspaceEntry,
  getWorkspaceRootInfo,
  listWorkspaceDirectory,
  moveWorkspaceEntry,
  uploadWorkspaceFiles,
  uploadWorkspaceMultipartFiles,
} from './filesystem.js';
import type {
  MultipartUploadFile,
  UploadFile,
  WorkspaceConfig,
  WorkspaceDependencies,
  WorkspaceDirectoryListing,
  WorkspaceEntry,
} from './filesystem.js';
import { getWorkspaceDownloadInfo, resolveWorkspaceDownload } from './download.js';
import {
  getWorkspaceGitStatus,
  workspaceGitCheckout,
  workspaceGitClone,
  workspaceGitCommit,
  workspaceGitFetch,
  workspaceGitLog,
  workspaceGitPull,
  workspaceGitPush,
  workspaceGitRemotes,
} from './git.js';

type WorkspaceRequest = Request;
type WorkspaceResponse = Response;

// ── Domain types ──────────────────────────────────────────────────────────

interface ProjectEntry {
  id: string;
  path: string;
  additionalPaths?: string[];
  label?: string | undefined;
  addedAt?: number | undefined;
  lastOpenedAt?: number | undefined;
}

interface WorkspaceSettings {
  projects?: ProjectEntry[] | undefined;
  activeProjectId?: string | undefined;
  lastDirectory?: string | undefined;
  [key: string]: unknown;
}

interface DocumentsAPI {
  runMutationForScope: <T>(
    root: string,
    scope: { kind: string; id: string },
    operation: () => Promise<T>,
    options: Record<string, unknown>,
  ) => Promise<T>;
}

interface RouteContext {
  config: WorkspaceConfig;
  fsPromises: typeof fs.promises;
  pathModule: typeof path;
  osModule: typeof os;
  documents?: DocumentsAPI | undefined;
  onGitStatus?: ((scope: string, status: unknown) => void | Promise<void>) | undefined;
}

interface RouteDependencies extends WorkspaceDependencies {
  path?: typeof path | undefined;
  osModule?: typeof os | undefined;
  os?: typeof os | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  cwd?: string | undefined;
  documents?: DocumentsAPI | undefined;
  onGitStatus?: ((scope: string, status: unknown) => void | Promise<void>) | undefined;
  readSettingsFromDisk?: (() => Promise<WorkspaceSettings>) | undefined;
  persistSettings?: ((changes: Partial<WorkspaceSettings>) => Promise<WorkspaceSettings>) | undefined;
  sanitizeProjects?: ((value: unknown) => ProjectEntry[] | undefined) | undefined;
}

interface OpenProjectDependencies {
  readSettingsFromDisk?: (() => Promise<WorkspaceSettings>) | undefined;
  persistSettings?: ((changes: Partial<WorkspaceSettings>) => Promise<WorkspaceSettings>) | undefined;
  sanitizeProjects?: ((value: unknown) => ProjectEntry[] | undefined) | undefined;
}

interface OpenProjectResult {
  success: true;
  project: ProjectEntry;
  settings: WorkspaceSettings;
}

interface TreeEntry extends WorkspaceEntry {
  children?: WorkspaceEntry[] | undefined;
}

interface TreeListing extends Omit<WorkspaceDirectoryListing, 'entries'> {
  entries: TreeEntry[];
}

interface DownloadInfo {
  type: 'file' | 'archive';
  fileName: string;
  filePath?: string | undefined;
  directoryPath?: string | undefined;
  baseName?: string | undefined;
  stream?: NodeJS.ReadableStream | undefined;
}

// ── Helpers ───────────────────────────────────────────────────────────────

const getRequestPath = (req: WorkspaceRequest): string => {
  const candidate = typeof req.query?.path === 'string'
    ? req.query.path
    : (typeof req.body?.path === 'string' ? req.body.path : '');
  return candidate;
};

const DOWNLOAD_OPTIONS = { dotfiles: 'allow' } as const;

const toErrorStatus = (error: unknown): number => {
  if (error && typeof error === 'object') {
    const err = error as NodeJS.ErrnoException & { statusCode?: number | undefined };
    if (Number.isInteger(err.statusCode)) return err.statusCode!;
    if (err.code === 'ENOENT') return 404;
    if (err.code === 'EEXIST') return 409;
    if (err.code === 'EACCES' || err.code === 'EPERM') return 403;
    if (err.name === 'MulterError') return 413;
  }
  return 500;
};

const sendError = (res: WorkspaceResponse, error: unknown): WorkspaceResponse => {
  const status = toErrorStatus(error);
  if (status >= 500) {
    console.error('[workspace] request failed:', error);
  }
  const message = error instanceof Error ? error.message : 'Workspace request failed';
  return res.status(status).json({
    error: message,
  });
};

const createRouteContext = (dependencies: RouteDependencies): RouteContext => {
  const fsPromises = dependencies.fsPromises || fs.promises;
  const pathModule = dependencies.pathModule || dependencies.path || path;
  const osModule = dependencies.osModule || dependencies.os || os;
  const env = dependencies.env || process.env;
  const config = createWorkspaceConfig({
    env,
    cwd: dependencies.cwd || process.cwd(),
    pathModule,
    osModule,
  }) as WorkspaceConfig;

  return { config, fsPromises, pathModule, osModule, documents: dependencies.documents, onGitStatus: dependencies.onGitStatus };
};

const runWorkspaceMutation = <T,>(
  context: RouteContext,
  ownerId: string,
  operation: () => Promise<T>,
  options: Record<string, unknown> = {},
): Promise<T> => {
  if (typeof context.documents?.runMutationForScope !== 'function') return operation();
  return context.documents.runMutationForScope(
    context.config.root,
    { kind: 'web-route', id: ownerId },
    operation,
    {
      ...options,
      // WorkspaceAPI includes bulk upload/archive/Git writers whose exact path
      // set may be discovered during the operation. Register one conservative
      // subtree writer with the kernel rather than maintaining another TS gate.
      resourceOperations: [{ resourceId: '', scope: 'subtree' }],
    },
  ) as Promise<T>;
};

const readTree = async (
  relativePath: string,
  depth: number,
  context: RouteContext,
): Promise<TreeListing> => {
  const current = await listWorkspaceDirectory(relativePath, context.config, context);
  if (depth <= 0) {
    return current as TreeListing;
  }

  const entries: TreeEntry[] = [];
  for (const entry of current.entries) {
    if (entry.type !== 'directory') {
      entries.push(entry);
      continue;
    }
    const child = await readTree(entry.relativePath, depth - 1, context).catch(() => null);
    entries.push({
      ...entry,
      ...(child ? { children: child.entries } : {}),
    });
  }

  return {
    ...current,
    entries,
  };
};

const openWorkspaceProject = async (
  relativePathValue: string,
  dependencies: OpenProjectDependencies,
  context: RouteContext,
): Promise<OpenProjectResult> => {
  const {
    readSettingsFromDisk = async (): Promise<WorkspaceSettings> => ({}),
    persistSettings = async (changes) => changes,
    sanitizeProjects = (value) => Array.isArray(value) ? value as ProjectEntry[] : [],
  } = dependencies;

  const resolved = await resolveWorkspacePath(relativePathValue, {
    root: context.config.root,
    fsPromises: context.fsPromises,
    pathModule: context.pathModule,
  });
  const stat = await context.fsPromises.stat(resolved.absolutePath);
  if (!stat.isDirectory()) {
    const error = new Error('Only workspace directories can be opened as projects') as Error & { statusCode: number };
    error.statusCode = 400;
    throw error;
  }

  const settings = await readSettingsFromDisk();
  const projects = sanitizeProjects(settings?.projects || []) ?? [];
  const now = Date.now();
  const existing = projects.find((project) => projectFolders(project).some((folder) => projectPathKey(folder) === projectPathKey(resolved.absolutePath)));
  const projectId = existing?.id ?? `project_${randomUUID()}`;
  const label = context.pathModule.basename(resolved.absolutePath) || resolved.absolutePath;
  const project: ProjectEntry = existing
    ? { ...existing, lastOpenedAt: now }
    : {
        id: projectId,
        path: resolved.absolutePath,
        label,
        addedAt: now,
        lastOpenedAt: now,
      };
  const nextProjects = existing
    ? projects.map((entry) => (entry === existing ? project : entry))
    : [...projects, project];

  const saved = await persistSettings({
    projects: nextProjects,
    activeProjectId: projectId,
    lastDirectory: resolved.absolutePath,
  });

  return {
    success: true,
    project,
    settings: saved,
  };
};

// ── Route registration ────────────────────────────────────────────────────

export const registerWorkspaceRoutes = (app: Express, dependencies: RouteDependencies = {}): void => {
  const context = createRouteContext(dependencies);
  const multipartUpload = multer({
    storage: multer.memoryStorage(),
    defParamCharset: 'utf8',
    limits: {
      fileSize: context.config.maxUploadBytes,
      files: 1000,
      fieldSize: 1024 * 1024,
    },
  });

  const parseMultipartUpload = (req: WorkspaceRequest, res: WorkspaceResponse): Promise<MultipartUploadFile[]> =>
    new Promise<MultipartUploadFile[]>((resolve, reject) => {
      multipartUpload.array('files')(req, res, (error?: unknown) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(Array.isArray(req.files) ? req.files : []);
      });
    });

  app.get('/api/workspace/root', async (_req, res) => {
    try {
      res.json(await getWorkspaceRootInfo(context.config, context));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/workspace/list', async (req, res) => {
    try {
      res.json(await listWorkspaceDirectory(getRequestPath(req), context.config, context));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/workspace/tree', async (req, res) => {
    try {
      const depthRaw = Number.parseInt(String(req.query?.depth ?? '2'), 10);
      const depth = Number.isFinite(depthRaw) ? Math.min(Math.max(depthRaw, 0), 6) : 2;
      res.json(await readTree(getRequestPath(req), depth, context));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/workspace/entry', async (req, res) => {
    try {
      res.json(await getWorkspaceEntry(getRequestPath(req), context.config, context));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/workspace/folder', async (req, res) => {
    try {
      res.json(await runWorkspaceMutation(
        context,
        'workspace.folder',
        () => createWorkspaceFolder(getRequestPath(req), context.config, context),
      ));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/workspace/file', async (req, res) => {
    try {
      res.json(await runWorkspaceMutation(
        context,
        'workspace.file',
        () => createWorkspaceFile(getRequestPath(req), context.config, {
          ...context,
          content: typeof req.body?.content === 'string' ? req.body.content : '',
        }),
      ));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.patch('/api/workspace/move', async (req, res) => {
    try {
      const from = typeof req.body?.from === 'string' ? req.body.from
        : typeof req.body?.oldPath === 'string' ? req.body.oldPath
        : '';
      const to = typeof req.body?.to === 'string' ? req.body.to
        : typeof req.body?.newPath === 'string' ? req.body.newPath
        : '';
      res.json(await runWorkspaceMutation(
        context,
        'workspace.move',
        () => moveWorkspaceEntry(from, to, context.config, context),
      ));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.delete('/api/workspace/entry', async (req, res) => {
    try {
      res.json(await runWorkspaceMutation(
        context,
        'workspace.delete',
        () => deleteWorkspaceEntry(getRequestPath(req), context.config, {
          ...context,
          permanent: req.body?.permanent === true,
        }),
      ));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/workspace/upload', async (req, res) => {
    try {
      if (req.is('multipart/form-data')) {
        const files = await parseMultipartUpload(req, res);
        res.json(await runWorkspaceMutation(
          context,
          'workspace.upload',
          () => uploadWorkspaceMultipartFiles(getRequestPath(req), files, context.config, context),
        ));
        return;
      }
      res.json(await runWorkspaceMutation(
        context,
        'workspace.upload',
        () => uploadWorkspaceFiles(getRequestPath(req), req.body?.files as UploadFile[] | undefined ?? [], context.config, context),
      ));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/workspace/archive/preview', async (req, res) => {
    try {
      res.json(await previewWorkspaceArchive(getRequestPath(req), context.config, context));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/workspace/archive/extract', async (req, res) => {
    try {
      res.json(await runWorkspaceMutation(
        context,
        'workspace.archive.extract',
        () => extractWorkspaceArchive(req.body ?? {}, context.config, context),
      ));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/workspace/download/check', async (req, res) => {
    try {
      res.json(await getWorkspaceDownloadInfo(getRequestPath(req), context.config, context));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/workspace/download', async (req, res) => {
    try {
      const download = await resolveWorkspaceDownload(getRequestPath(req), context.config, context) as DownloadInfo;
      if (download.type === 'file') {
        return res.download(download.filePath!, download.fileName, DOWNLOAD_OPTIONS);
      }

      res.attachment(download.fileName);
      res.type('zip');
      download.stream!.on('error', (error: unknown) => {
        if (!res.headersSent) {
          sendError(res, error);
          return;
        }
        res.destroy(error instanceof Error ? error : new Error('Workspace archive stream failed'));
      });
      download.stream!.pipe(res);
      return;
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/workspace/projects/open', async (req, res) => {
    try {
      res.json(await openWorkspaceProject(getRequestPath(req), dependencies, context));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/workspace/git/status', async (req, res) => {
    try {
      const mode = req.query?.mode === 'light' ? { mode: 'light' } : {};
      const status = await getWorkspaceGitStatus(getRequestPath(req), context.config, { ...context, options: mode });
      res.json(status);
      void Promise.resolve().then(() => context.onGitStatus?.(context.config.root, status)).catch((error) => {
        console.warn('[workspace] Failed to observe Git status:', error instanceof Error ? error.message : error);
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/workspace/git/fetch', async (req, res) => {
    try {
      res.json(await runWorkspaceMutation(
        context,
        'workspace.git.fetch',
        () => workspaceGitFetch(getRequestPath(req), req.body, context.config, context),
        { mode: 'process', purpose: 'workspace-git-fetch' },
      ));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/workspace/git/clone', async (req, res) => {
    try {
      res.json(await runWorkspaceMutation(
        context,
        'workspace.git.clone',
        () => workspaceGitClone(getRequestPath(req), req.body, context.config, context),
        { mode: 'process', purpose: 'workspace-git-clone' },
      ));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/workspace/git/pull', async (req, res) => {
    try {
      res.json(await runWorkspaceMutation(
        context,
        'workspace.git.pull',
        () => workspaceGitPull(getRequestPath(req), req.body, context.config, context),
        { mode: 'process', purpose: 'workspace-git-pull' },
      ));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/workspace/git/push', async (req, res) => {
    try {
      res.json(await runWorkspaceMutation(
        context,
        'workspace.git.push',
        () => workspaceGitPush(getRequestPath(req), req.body, context.config, context),
        { mode: 'process', purpose: 'workspace-git-push' },
      ));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/workspace/git/checkout', async (req, res) => {
    try {
      const branch = String(req.body?.branch || '').trim();
      if (!branch) return res.status(400).json({ error: 'branch is required' });
      res.json(await runWorkspaceMutation(
        context,
        'workspace.git.checkout',
        () => workspaceGitCheckout(getRequestPath(req), branch, context.config, context),
        { mode: 'process', purpose: 'workspace-git-checkout' },
      ));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/workspace/git/commit', async (req, res) => {
    try {
      res.json(await runWorkspaceMutation(
        context,
        'workspace.git.commit',
        () => workspaceGitCommit(getRequestPath(req), req.body, context.config, context),
        { mode: 'process', purpose: 'workspace-git-commit' },
      ));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/workspace/git/log', async (req, res) => {
    try {
      res.json(await workspaceGitLog(getRequestPath(req), req.query, context.config, context));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/workspace/git/remotes', async (req, res) => {
    try {
      res.json(await workspaceGitRemotes(getRequestPath(req), context.config, context));
    } catch (error) {
      sendError(res, error);
    }
  });
};
