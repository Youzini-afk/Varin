import type { Express, RequestHandler } from 'express';
import type { NativeResourceCopy, NativeResourceCreate, NativeResourceRemove, NativeResourceUpdate, ResourceManagementTarget } from '@varin/application-client';
import { ResourceManagementFailure, type ResourceManagement } from './management.js';

/** Every route is authenticated; only saved project IDs and opaque catalog IDs cross this boundary. */
export function registerResourceManagementRoutes(app: Express, owner: ResourceManagement, requireAuth: RequestHandler): void {
  const fields = {
    list: [], read: ['id'], create: ['scope', 'name', 'content', 'key'],
    update: ['id', 'content', 'expectedRevision', 'key'], remove: ['id', 'expectedRevision', 'key'], copy: ['id', 'expectedRevision', 'scope', 'name', 'key'],
  } as const;
  for (const action of Object.keys(fields) as (keyof typeof fields)[]) {
    app.post(`/api/resources/${action}`, requireAuth, async (request, response) => {
      const abort = new AbortController();
      const closed = () => { if (!response.writableEnded) abort.abort(); };
      response.once('close', closed);
      try {
        const raw: unknown = request.body;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'target' && !(fields[action] as readonly string[]).includes(key))) {
          throw new ResourceManagementFailure(400, 'resource-invalid', 'Unsupported resource request fields.');
        }
        const { target, ...input } = raw as { target: ResourceManagementTarget } & Record<string, unknown>;
        const result = action === 'list' ? await owner.list(target, abort.signal)
          : action === 'read' ? await owner.read(target, input.id as string, abort.signal)
          : action === 'create' ? await owner.create(target, input as unknown as NativeResourceCreate, abort.signal)
          : action === 'update' ? await owner.update(target, input as unknown as NativeResourceUpdate, abort.signal)
          : action === 'remove' ? await owner.remove(target, input as unknown as NativeResourceRemove, abort.signal)
          : await owner.copy(target, input as unknown as NativeResourceCopy, abort.signal);
        if (!response.destroyed) response.json(result);
      } catch (error) {
        if (response.destroyed) return;
        if (error instanceof ResourceManagementFailure) response.status(error.status).json({ code: error.code, message: error.message });
        else {
          const known = error as { statusCode?: number; status?: number; code?: string; message?: string };
          const status = known.statusCode ?? known.status ?? 500;
          response.status(status).json({ code: known.code ?? 'resource-unavailable', message: status < 500 ? known.message ?? 'Resource request failed.' : 'Native resource owner is unavailable.' });
        }
      } finally { response.removeListener('close', closed); }
    });
  }
}
