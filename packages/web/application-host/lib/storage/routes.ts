import { createHash } from 'node:crypto';
import type { VarinRequestAuthContext } from '../client-auth/request-context.js';
import express, { type Express, type RequestHandler } from 'express';
import { createStorageService, parseStorageScope, StorageServiceError } from './service.js';

export function registerStorageRoutes(app: Express, service: ReturnType<typeof createStorageService>, requireAuth: RequestHandler): void {
  const json = express.json({ limit: '1mb' });
  const route = (name: string, action: (body: Record<string, unknown>, signal: AbortSignal, principal: string) => Promise<unknown>) => {
    app.post(`/api/storage/${name}`, requireAuth, json, async (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      const controller = new AbortController();
      const close = () => { if (!response.writableEnded) controller.abort(); };
      response.once('close', close);
      try {
        const auth: VarinRequestAuthContext | undefined = request.varinAuth;
        if (!auth) throw new StorageServiceError(403, 'storage-permission-denied', 'Storage management requires a Host session or an authorized client');
        let canCleanup = true;
        if (auth.type === 'client') {
          const capabilities = new Set(auth.client.capabilities ?? []);
          const permits = (capability: string) => capabilities.has(capability) || capabilities.has('*') || capabilities.has('admin') || capabilities.has(capability.replace(/:[^:]+$/, ':*'));
          canCleanup = ['instance:write', 'config:write', 'filesystem:delete'].every(permits);
          const required = name === 'cleanup' ? ['instance:write', 'config:write', 'filesystem:delete'] : ['instance:read', 'config:read', 'filesystem:read'];
          if ((auth.client.allowedDirectories?.length ?? 0) > 0 || required.some(capability => !permits(capability))) {
            throw new StorageServiceError(403, 'storage-permission-denied', 'This client has no Host-wide storage management permission');
          }
        }
        const principal = auth.type === 'client' ? `client:${auth.clientId}` : `session:${createHash('sha256').update(auth.token ?? 'local-session').digest('hex')}`;
        if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new StorageServiceError(400, 'invalid-input', 'A storage request is required');
        const result = await action(request.body, controller.signal, principal);
        response.json(name === 'inventory' ? { ...result as object, canCleanup } : result);
      } catch (error) {
        if (!response.destroyed) response.status(error instanceof StorageServiceError ? error.status : 500).json({ code: error instanceof StorageServiceError ? error.code : 'storage-unavailable', error: error instanceof Error ? error.message : 'Storage is unavailable' });
      } finally { response.removeListener('close', close); }
    });
  };
  const scope = (body: Record<string, unknown>) => {
    if (Object.keys(body).some(key => key !== 'scope')) throw new StorageServiceError(400, 'invalid-input', 'Storage inventory accepts only a registered scope');
    return parseStorageScope(body.scope);
  };
  route('inventory', (body, signal) => service.inventory(scope(body), signal));
  route('preview', (body, _signal, principal) => service.preview(scope(body), principal));
  route('cleanup', (body, _signal, principal) => {
    if (Object.keys(body).some(key => !['previewId', 'candidateIds'].includes(key)) || typeof body.previewId !== 'string' || !Array.isArray(body.candidateIds) || body.candidateIds.some(id => typeof id !== 'string')) throw new StorageServiceError(400, 'invalid-input', 'A preview and selected candidate identities are required');
    // Disconnecting the renderer does not cancel an already accepted effect.
    return service.cleanup(body.previewId, body.candidateIds, principal);
  });
}
