import type { Express, RequestHandler } from 'express';
import type { ModelsService } from './service.js';
import { object, ModelConfigurationError } from './configuration.js';
import type { EgressFetch } from '../harness/egress.js';

export function registerModelRoutes(app: Express, models: ModelsService, requireAuth: RequestHandler, fetchImpl: EgressFetch) {
  const actions = {
    read: () => models.read(),
    save: (input: Record<string, unknown>) => models.save(input.channel as Parameters<ModelsService['save']>[0], input.expectedRevision as string),
    remove: (input: Record<string, unknown>) => models.remove(input.id as string, input.expectedRevision as string),
    discover: (input: Record<string, unknown>, signal: AbortSignal) => models.discover(input.id as string, fetchImpl, signal),
    'credentials/store': async (input: Record<string, unknown>) => ({ reference: await models.storeCredential(input.secret as string, input.reference as string | undefined) }),
    'credentials/remove': async (input: Record<string, unknown>) => { await models.removeCredential(input.reference as string); return {}; },
    'authorization/start': (input: Record<string, unknown>) => models.signIn(input.provider as string, input.reference as string),
    'authorization/read': (input: Record<string, unknown>) => models.authorizations.read(input.id as string),
    'authorization/reply': (input: Record<string, unknown>) => { models.authorizations.reply(input.id as string, input.redirect as string); return {}; },
    'authorization/cancel': (input: Record<string, unknown>) => { models.authorizations.cancel(input.id as string); return {}; },
    'settings/read': (input: Record<string, unknown>) => models.settings.snapshot(input.cwd as string | undefined),
    'settings/update': (input: Record<string, unknown>) => models.settings.update(input as Parameters<ModelsService['settings']['update']>[0]),
  };
  for (const [name, action] of Object.entries(actions)) app.post(`/api/models/${name}`, requireAuth, async (request, response) => {
    const controller = new AbortController();
    const close = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', close);
    try {
      const input: unknown = request.body;
      if (!object(input) || input.cwd !== undefined && typeof input.cwd !== 'string'
        || ['save', 'remove'].includes(name) && typeof input.expectedRevision !== 'string'
        || ['remove', 'discover'].includes(name) && typeof input.id !== 'string'
        || name === 'credentials/store' && (typeof input.secret !== 'string' || input.reference !== undefined && typeof input.reference !== 'string')
        || name === 'credentials/remove' && typeof input.reference !== 'string'
        || name === 'authorization/start' && (typeof input.reference !== 'string' || typeof input.provider !== 'string')
        || name.startsWith('authorization/') && name !== 'authorization/start' && typeof input.id !== 'string'
        || name === 'authorization/reply' && typeof input.redirect !== 'string') throw new ModelConfigurationError('invalid_params', 'Invalid model settings request');
      response.json(await action(input, controller.signal));
    } catch (error) {
      if (error instanceof ModelConfigurationError) response.status(error.status).json({ code: error.code, message: error.message });
      else response.status(503).json({ code: 'model-settings-unavailable', message: 'Model configuration is unavailable. Check the selected configuration file.' });
    } finally { response.removeListener('close', close); }
  });
}
