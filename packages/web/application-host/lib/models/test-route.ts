import type { Express, RequestHandler } from 'express';
import { THINKING_LEVELS } from '@varin/protocol';
import type { ModelConnectionTest, ModelConnectionTestResult } from '@varin/application-client';
import type { ModelsService } from './service.js';
import { ModelConfigurationError, object, revisionOf } from './configuration.js';
import type { createModelAuthority } from '../kernel/model-authority.js';
import type { ModelTextService } from '../model-text/service.js';

const configurationFailures: Record<string, string> = {
  'anthropic-output-capacity-required': 'Set the model’s maximum output tokens before testing.',
  'model-thinking-level-unavailable': 'Choose a thinking option supported by this model.',
  'model-thinking-output-capacity-insufficient': 'The thinking budget must fit within the model’s output capacity.',
  'model-thinking-mapping-invalid': 'Check the model’s thinking level mapping.',
  'model-thinking-budget-field-required': 'Set the request field used for this model’s thinking budget.',
  'model-thinking-budget-unavailable': 'This protocol does not support a token thinking budget.',
  'model-thinking-protocol-unavailable': 'This model’s thinking format is not supported by the selected protocol.',
  'vertex-project-location-required': 'Enter the Vertex project and location.',
  'credential-missing': 'Enter an API key or sign in to this service.',
};

/** Explicit settings tests keep the native inference receipt and never publish the draft. */
export function registerModelTestRoute(app: Express, models: ModelsService, authority: ReturnType<typeof createModelAuthority>, text: ModelTextService, requireAuth: RequestHandler) {
  app.post('/api/models/test', requireAuth, async (request, response) => {
    const abort = new AbortController();
    const closed = () => { if (!response.writableEnded) abort.abort(); };
    response.once('close', closed);
    try {
      const body: unknown = request.body;
      if (!object(body) || !object(body.channel) || typeof body.key !== 'string' || !body.key.trim()
        || typeof body.modelId !== 'string' || !body.modelId.trim() || body.secret !== undefined && typeof body.secret !== 'string'
        || body.thinkingLevel !== undefined && !(THINKING_LEVELS as readonly unknown[]).includes(body.thinkingLevel)) throw new ModelConfigurationError('invalid_params', 'Choose a model and connection to test');
      const input = body as unknown as ModelConnectionTest;
      const started = Date.now();
      const model = { providerId: input.channel.id, modelId: input.modelId, ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}) };
      const result = await text.generate({ key: input.key, purpose: 'text', model, system: 'Reply with OK only.', prompt: 'Connection test.', signal: abort.signal }, {
        identity: revisionOf({ channel: input.channel, thinkingLevel: input.thinkingLevel }),
        resolve: async () => authority.resolveCaptured(await models.captureDraftModel(input, input.modelId), model),
      });
      if (!response.destroyed) response.json({ requestId: result.requestId, modelId: input.modelId, elapsedMs: Date.now() - started, text: result.text } satisfies ModelConnectionTestResult);
    } catch (error) {
      if (response.destroyed) return;
      const known = error as { status?: number; statusCode?: number; code?: string; message?: string; requestId?: string };
      const message = known.code && configurationFailures[known.code];
      response.status(known.statusCode ?? (error instanceof ModelConfigurationError ? error.status : message ? 400 : 503)).json({
        code: known.code ?? 'model-test-failed', message: message || (error instanceof ModelConfigurationError || known.requestId ? known.message : 'Model test could not be completed.'),
        ...(known.requestId ? { requestId: known.requestId } : {}),
      });
    } finally { response.removeListener('close', closed); }
  });
}
