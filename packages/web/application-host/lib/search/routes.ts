import { isDocumentAuthorityError } from '../documents/errors.js';
import type { createFsSearchRuntime } from '../fs/search.js';
import type { Express, Request, RequestHandler, Response } from 'express';
import type os from 'node:os';
import type path from 'node:path';
import type { createWorkspaceContentSearch } from './content.js';

const sendError = (res: Response, error: unknown): Response => {
  if (isDocumentAuthorityError(error)) {
    return res.status(error.statusCode).json({
      error: error.message,
      reason: error.code,
    });
  }
  const message = error instanceof Error ? error.message : 'Search request failed';
  return res.status(500).json({ error: message, reason: 'failed' });
};

const readBody = (req: Request): Record<string, unknown> => (
  req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {}
);

interface ResolvedProjectDirectory {
  directory?: string | null | undefined;
  resolved?: string | undefined;
}

interface ResolveSearchDirectoryOptions {
  directory: unknown;
  normalizeDirectoryPath?: ((value: string) => string) | undefined;
  os: Pick<typeof os, 'homedir'>;
  path: typeof path;
  req: Request;
  resolveProjectDirectory(req: Request): Promise<ResolvedProjectDirectory | null>;
}

const resolveSearchDirectory = async ({
  req,
  directory,
  path,
  os,
  normalizeDirectoryPath,
  resolveProjectDirectory,
}: ResolveSearchDirectoryOptions): Promise<string> => {
  const raw = typeof directory === 'string' ? directory.trim() : '';
  const resolvedProject = await resolveProjectDirectory(req);
  const fallback = resolvedProject?.directory
    || resolvedProject?.resolved
    || (typeof os.homedir === 'function' ? os.homedir() : process.cwd());
  const target = raw
    ? (path.isAbsolute(raw) ? raw : path.resolve(fallback, raw))
    : fallback;
  const normalized = typeof normalizeDirectoryPath === 'function'
    ? normalizeDirectoryPath(target)
    : target;
  return normalized;
};

export interface WorkspaceSearchRouteOptions {
  contentSearch: ReturnType<typeof createWorkspaceContentSearch>;
  fileSearch: Pick<ReturnType<typeof createFsSearchRuntime>, "searchFilesystemFiles">;
  normalizeDirectoryPath?: (value: string) => string;
  os: Pick<typeof os, "homedir">;
  path: typeof path;
  resolveProjectDirectory(req: Request): Promise<ResolvedProjectDirectory | null>;
  authorizeSearchDirectory?: (directory: string) => Promise<boolean>;
  uiAuthController?: { requireAuth?: RequestHandler };
}
export const registerWorkspaceSearchRoutes = (app: Express, {
  contentSearch, fileSearch, uiAuthController, path, os, normalizeDirectoryPath, resolveProjectDirectory,
  authorizeSearchDirectory,
}: WorkspaceSearchRouteOptions) => {
  const requireAuth = uiAuthController?.requireAuth ?? ((_req, _res, next) => next());

  app.get('/api/find/file', requireAuth, async (req, res) => {
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.on('aborted', onClose);
    res.on('close', onClose);
    try {
      const query = typeof req.query?.query === 'string' ? req.query.query : '';
      const directory = await resolveSearchDirectory({
        req,
        directory: req.query?.directory,
        path,
        os,
        normalizeDirectoryPath,
        resolveProjectDirectory,
      });
      const allowed = authorizeSearchDirectory
        ? await authorizeSearchDirectory(directory)
        : await (async () => {
          const project = await resolveProjectDirectory(req);
          if (!project?.resolved) return false;
          const relative = path.relative(project.resolved, directory);
          return !(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
        })();
      if (!allowed) {
        return res.status(403).json({ error: 'Search directory is outside the permitted host roots', reason: 'path-escape' });
      }
      const limit = Number.parseInt(String(req.query?.limit ?? ''), 10);
      const includeHidden = req.query?.includeHidden === 'true';
      const respectGitignore = req.query?.respectGitignore !== 'false';
      const files = await fileSearch.searchFilesystemFiles(directory, {
        query,
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
        includeHidden,
        respectGitignore,
        signal: controller.signal,
      });
      return res.json(files.map((file) => file.relativePath));
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'path-escape') {
        return res.status(403).json({ error: error instanceof Error ? error.message : 'Path escaped', reason: 'path-escape' });
      }
      return sendError(res, error);
    } finally {
      req.off?.('aborted', onClose);
      res.off?.('close', onClose);
    }
  });

  app.post('/api/workspace/search/content', requireAuth, async (req, res) => {
    const body = readBody(req);
    const generation = Number.parseInt(String(req.headers['x-varin-generation'] ?? ''), 10);
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.on('aborted', onClose);
    res.on('close', onClose);
    try {
      const stream = String(req.headers.accept ?? '').includes('application/x-ndjson');
      if (stream) {
        res.status(200);
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.flushHeaders();
        const result = await contentSearch.searchContent(body, {
          collect: false,
          generation: Number.isFinite(generation) ? generation : 0,
          signal: controller.signal,
          onBatch: (hits) => (
            res.writableEnded || res.write(`${JSON.stringify({ type: 'batch', hits })}\n`)
          ),
          onDrain: () => new Promise<void>((resolve) => { res.once('drain', () => resolve()); }),
        });
        if (!res.writableEnded) {
          const finalResult = result.status === 'ready'
            ? { status: 'ready', generation: result.generation, ...(result.incomplete ? { incomplete: true } : {}) }
            : result;
          res.end(`${JSON.stringify({ type: 'result', result: finalResult })}\n`);
        }
        return;
      }
      const result = await contentSearch.searchContent(body, {
        generation: Number.isFinite(generation) ? generation : 0,
        signal: controller.signal,
      });
      return res.json(result);
    } catch (error) {
      return sendError(res, error);
    } finally {
      req.off?.('aborted', onClose);
      res.off?.('close', onClose);
    }
  });

  return { contentSearch, fileSearch };
};
