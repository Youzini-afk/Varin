import type { Express, Response } from 'express';
import type { ModelTextService } from './service.js';
import { parseModelTextSelection } from './service.js';
export function registerModelTextRoutes(app: Express, { service }: { service: ModelTextService }) {
  const failure = (res: Response, error: unknown) => {
    const value = error as { code?: string; statusCode?: number; requestId?: string; message?: string };
    res.status(value.statusCode ?? 500).json({ error: value.message ?? 'Text generation failed.', code: value.code ?? 'model-text-failed', ...(value.requestId ? { requestId: value.requestId } : {}) });
  };
  app.get('/api/model-text', async (_req, res) => {
    try { res.json({ model: await service.describe() }); } catch (error) { failure(res, error); }
  });
  app.post('/api/model-text/generate', async (req, res) => {
    try {
      const body = req.body ?? {};
      // Disconnect only loses observation. The caller keeps its key and can inspect/cancel the exact original.
      res.json(await service.generate({ key: body.key, purpose: body.purpose, prompt: body.prompt,
        ...(body.system === undefined ? {} : { system: body.system }),
        ...(body.model === undefined ? {} : { model: parseModelTextSelection(body.model) }),
        ...(body.maxOutputTokens === undefined ? {} : { maxOutputTokens: body.maxOutputTokens }),
        ...(body.responseSchema === undefined ? {} : { responseSchema: body.responseSchema }),
        ...(body.retryOf === undefined ? {} : { retryOf: body.retryOf }) }));
    } catch (error) { if (!res.destroyed) failure(res, error); }
  });
  app.get('/api/model-text/requests/:requestId', async (req, res) => {
    try { res.json(await service.inspect(req.params.requestId!)); } catch (error) { failure(res, error); }
  });
  app.post('/api/model-text/requests/:requestId/cancel', async (req, res) => {
    try { res.json(await service.cancel(req.params.requestId!)); } catch (error) { failure(res, error); }
  });
}
