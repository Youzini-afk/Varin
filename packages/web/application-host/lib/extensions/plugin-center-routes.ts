import type { Express, RequestHandler, Request, Response } from 'express';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ExtensionCatalogRevisionConflictError } from '@varin/extension-host';
import type { ExtensionReleaseManager } from '@varin/extension-host';
import { parseVarinExtensionPackageSource } from '@varin/extension-contract';
import type { VarinExtensionReleaseInstallRequest } from '@varin/extension-contract';
import type { PluginDiscoveryService } from './discovery.js';

interface PluginCenterRouteDependencies {
  discovery: PluginDiscoveryService;
  releases: ExtensionReleaseManager;
  requireAuth: RequestHandler;
  isDraining?: () => boolean;
}

const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('A request object is required');
  return value as Record<string, unknown>;
};
const optionalId = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value)) throw new Error('Invalid extension identity');
  return value;
};

function installRequest(value: unknown): VarinExtensionReleaseInstallRequest {
  const body = record(value);
  if (typeof body.previewId !== 'string' || !body.previewId || typeof body.expectedHostId !== 'string' || !body.expectedHostId
    || typeof body.expectedRevision !== 'number' || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0
    || (body.replaceSource !== undefined && typeof body.replaceSource !== 'boolean')) {
    throw new Error('Installation requires the original preview, Host, and catalog revision');
  }
  return { previewId: body.previewId, expectedHostId: body.expectedHostId, expectedRevision: body.expectedRevision,
    ...(body.replaceSource !== undefined ? { replaceSource: body.replaceSource } : {}) };
}

/** An HTTP observation ending is not proof that a committed catalog mutation was undone. */
async function observed<T>(req: Request, res: Response, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const disconnect = () => { if (!res.writableEnded) controller.abort(new Error('Plugin request disconnected')); };
  req.once('aborted', disconnect);
  res.once('close', disconnect);
  if (req.aborted || res.destroyed) disconnect();
  try { return await operation(controller.signal); }
  finally { req.off('aborted', disconnect); res.off('close', disconnect); }
}

export function registerPluginCenterRoutes(app: Express, { discovery, releases, requireAuth, isDraining = () => false }: PluginCenterRouteDependencies): void {
  const route = (operation: (req: Request, res: Response) => Promise<unknown>): RequestHandler => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (isDraining()) return res.status(503).json({ error: { code: 'host_draining', message: 'Application Host is stopping', retryable: true } });
    try {
      const result = await operation(req, res);
      if (!res.destroyed && !res.writableEnded) return res.json(result);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const conflict = error instanceof ExtensionCatalogRevisionConflictError;
      return res.status(conflict ? 409 : 400).json({ error: {
        code: conflict ? 'revision_conflict' : 'plugin_request_failed',
        message: error instanceof Error ? error.message : 'Plugin request failed',
        retryable: conflict,
      } });
    }
  };
  app.get('/api/varin/extensions/v1/discovery', requireAuth, route(() => discovery.snapshot()));
  app.post('/api/varin/extensions/v1/discovery/resolve-installed', requireAuth, route(req => {
    const body = record(req.body);
    return discovery.resolveInstalled(parseVarinExtensionPackageSource(body.source), optionalId(body.extensionId));
  }));
  app.post('/api/varin/extensions/v1/discovery/refresh', requireAuth, route(() => discovery.refresh()));
  app.put('/api/varin/extensions/v1/discovery/sources', requireAuth, route(req => discovery.setSources(record(req.body).sources)));
  app.post('/api/varin/extensions/v1/releases/preview', requireAuth, route((req, res) => {
    const body = record(req.body);
    const extensionId = optionalId(body.extensionId);
    if (body.source === undefined) {
      if (!extensionId) throw new Error('A source or installed extension identity is required');
      return observed(req, res, signal => releases.previewInstalled(extensionId, signal));
    }
    const source = parseVarinExtensionPackageSource(body.source);
    return observed(req, res, signal => releases.preview(source, extensionId, signal));
  }));
  app.post('/api/varin/extensions/v1/releases/install', requireAuth, route((req, res) => {
    const request = installRequest(req.body);
    return observed(req, res, signal => releases.install(request, signal));
  }));
  app.post('/api/varin/extensions/v1/releases/preview-archive', requireAuth, route((req, res) => observed(req, res, async signal => {
    if (req.headers['content-type'] !== 'application/octet-stream') throw new Error('Upload a release archive as application/octet-stream');
    const rawName = req.headers['x-varin-archive-name'];
    const name = typeof rawName === 'string' ? decodeURIComponent(rawName) : '';
    if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) throw new Error('An archive filename is required');
    const temporary = await mkdtemp(join(tmpdir(), 'varin-plugin-upload-'));
    try {
      const archive = join(temporary, 'package.tgz');
      await pipeline(req, createWriteStream(archive, { flags: 'wx', mode: 0o600 }), { signal });
      return await releases.previewArchive(archive, name, signal);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  })));
  app.post('/api/varin/extensions/v1/releases/discard', requireAuth, route(async req => {
    const body = record(req.body);
    if (typeof body.previewId !== 'string' || !body.previewId) throw new Error('A preview identity is required');
    releases.discard(body.previewId);
    return { discarded: true };
  }));
  app.post('/api/varin/extensions/v1/updates', requireAuth, route(req => releases.checkUpdates(optionalId(record(req.body).extensionId))));
}
