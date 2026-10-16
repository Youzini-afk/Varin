import { createHash } from 'node:crypto';
import type { VarinRequestAuthContext } from '../client-auth/request-context.js';
import express, { type Express, type RequestHandler } from 'express';
import { createStorageService, parseStorageScope, StorageServiceError } from './service.js';
import { createStorageCoordinator, parseStorageTarget } from './coordinator.js';

export function registerStorageRoutes(app: Express, service: ReturnType<typeof createStorageService>, requireAuth: RequestHandler, coordinator?: ReturnType<typeof createStorageCoordinator>): void {
  const json = express.json({ limit: '1mb' });
  // The managed alias is deliberately local-only. A renderer cannot recursively
  // forward through B into B's connections using A's trusted credential.
  for (const [base, localOnly] of [['/api/storage', false], ['/api/harness/managed-execution/v1/storage', true]] as const) {
    for (const name of ['inventory', 'preview', 'cleanup'] as const) {
      app.post(`${base}/${name}`, requireAuth, json, async (request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Varin-Managed-Host', service.device.id);
        const controller = new AbortController();
        const close = () => { if (!response.writableEnded) controller.abort(); };
        response.once('close', close);
        try {
          const auth: VarinRequestAuthContext | undefined = request.varinAuth;
          if (!auth || (localOnly && auth.type !== 'client')) throw new StorageServiceError(403, 'storage-permission-denied', 'Storage management requires an authorized Host principal');
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
          const body = request.body as Record<string, unknown>;
          const owner = !localOnly && coordinator ? coordinator : service;
          if (name === 'cleanup') {
            if (Object.keys(body).some(key => !['previewId', 'candidateIds'].includes(key)) || typeof body.previewId !== 'string' || !Array.isArray(body.candidateIds) || body.candidateIds.some(id => typeof id !== 'string')) throw new StorageServiceError(400, 'invalid-input', 'A preview and selected candidate identities are required');
            // Disconnecting an observer does not cancel an already accepted effect.
            response.json(await owner.cleanup(body.previewId, body.candidateIds as string[], principal));
          } else {
            if (Object.keys(body).some(key => key !== 'scope' && (!coordinator || localOnly || key !== 'target'))) throw new StorageServiceError(400, 'invalid-input', 'Storage accepts only a registered scope and configured device identity');
            const scope = parseStorageScope(body.scope), target = parseStorageTarget(body.target);
            if (name === 'preview') response.json(await owner.preview(scope, principal, target));
            else {
              const result = await owner.inventory(scope, controller.signal, target);
              response.json({ ...result, canCleanup: canCleanup && result.canCleanup });
            }
          }
        } catch (error) {
          if (!response.destroyed) response.status(error instanceof StorageServiceError ? error.status : 500).json({ code: error instanceof StorageServiceError ? error.code : 'storage-unavailable', error: error instanceof Error ? error.message : 'Storage is unavailable' });
        } finally { response.removeListener('close', close); }
      });
    }
  }
}
