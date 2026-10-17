import type { Express, RequestHandler } from 'express';
import type { ModelsService } from './service.js';
import { object, ModelConfigurationError } from './configuration.js';
import { EgressError, type EgressErrorKind, type EgressFetch } from '../harness/egress.js';
import type { ModelConnectionDraft } from '@varin/application-client';

// Keep the owner classification, but never project raw dependency messages or causes.
const networkMessages: Record<EgressErrorKind, string> = {
  dns: 'Model endpoint DNS lookup failed.',
  'scheme-denied': 'The Application Host only allows HTTP(S) model endpoints.',
  'private-network': 'This Application Host blocks model connections to local or private network addresses.',
  'special-purpose': 'This Application Host blocks model connections to special-purpose network addresses.',
  'proxy-unavailable': 'The Application Host could not connect to its configured proxy.',
  'proxy-auth': 'The Application Host proxy authentication failed.',
  'proxy-config-invalid': 'The Application Host proxy configuration is invalid.',
  tls: 'The model connection failed during TLS setup.',
  connect: 'The Application Host could not connect to the model endpoint.',
  timeout: 'The model connection timed out.',
  cancelled: 'The model request was cancelled.',
  unknown: 'The model network request failed.',
};

export function registerModelRoutes(app: Express, models: ModelsService, requireAuth: RequestHandler, fetchImpl: EgressFetch) {
  const actions = {
    read: () => models.read(),
    directory: (input: Record<string, unknown>) => models.directorySnapshot(input.type as string, input.channelId as string | undefined),
    'directory/refresh': () => { void models.modelDirectory.refresh(true); return models.modelDirectory.status(); },
    save: (input: Record<string, unknown>) => models.save(input.channel as Parameters<ModelsService['save']>[0], input.expectedRevision as string),
    remove: (input: Record<string, unknown>) => models.remove(input.id as string, input.expectedRevision as string),
    discover: (input: Record<string, unknown>, signal: AbortSignal) => models.discover(input.id as string, fetchImpl, signal),
    'discover-draft': (input: Record<string, unknown>, signal: AbortSignal) => models.discoverDraft(input as unknown as ModelConnectionDraft, fetchImpl, signal),
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
        || name === 'directory' && (typeof input.type !== 'string' || input.channelId !== undefined && typeof input.channelId !== 'string')
        || name === 'discover-draft' && (!object(input.channel) || input.secret !== undefined && typeof input.secret !== 'string')
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
      else if (error instanceof EgressError) {
        const blocked = ['scheme-denied', 'private-network', 'special-purpose'].includes(error.kind);
        response.status(blocked ? 403 : 503).json({ code: `model-egress-${error.kind}`, message: networkMessages[error.kind] });
      } else response.status(503).json({ code: 'model-settings-unavailable', message: 'The model settings request could not be completed.' });
    } finally { response.removeListener('close', close); }
  });
}
