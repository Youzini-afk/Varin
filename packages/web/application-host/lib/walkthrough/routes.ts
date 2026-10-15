import type { Express, Response } from 'express';

interface WalkthroughService {
  modelText: import('../model-text/service.js').ModelTextService;
  cancelWalkthroughGeneration: unknown;
  generateWalkthrough: unknown;
  getGenerationStage: unknown;
  getPullRequestDiff: unknown;
  getRepositoryRootFor: unknown;
  getWalkthrough: unknown;
}

const invokeService = async <Result>(
  service: WalkthroughService,
  method: keyof WalkthroughService,
  args: unknown[],
): Promise<Result> => {
  const handler = service[method];
  if (typeof handler !== 'function') throw new Error(`Walkthrough service method is unavailable: ${method}`);
  return await Reflect.apply(handler, service, args) as Result;
};

// `req.destroyed` is true for every healthy request once the body parser has
// consumed the stream, so the response socket is the real disconnect signal.
const clientIsGone = (res: Response): boolean => res.writableEnded || res.destroyed;

export function registerWalkthroughRoutes(app: Express, { getWalkthroughService }: {
  getWalkthroughService: () => Promise<WalkthroughService>;
}): void {
  const respondWithError = (res: Response, error: unknown, fallback: string): void => {
    const failure = error && typeof error === 'object' ? error as Record<string, unknown> : {};
    const statusCode = Number(failure.statusCode) || 500;
    if (statusCode >= 500) console.error(`${fallback}:`, error);
    res.status(statusCode).json({
      error: typeof failure.message === 'string' ? failure.message : fallback,
      ...(failure.code ? { code: failure.code } : {}),
      ...(failure.requestId ? { requestId: failure.requestId } : {}),
      ...(failure.model ? { model: failure.model } : {}),
      ...(Number.isFinite(failure.requiredChars) ? { requiredChars: failure.requiredChars } : {}),
      ...(Number.isFinite(failure.availableChars) ? { availableChars: failure.availableChars } : {}),
    });
  };

  const readSource = (value: unknown): unknown => {
    if (typeof value !== 'string' || !value) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };

  const pullRequestDependency = (service: WalkthroughService) => ({
    modelText: service.modelText,
    getPullRequestDiff: (directory: string, number: number) => (
      invokeService(service, 'getPullRequestDiff', [directory, number])
    ),
  });

  app.get('/api/walkthrough', async (req, res) => {
    try {
      const service = await getWalkthroughService();
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
      const result = await invokeService(service, 'getWalkthrough', [
        {
          directory,
          source: readSource(req.query.source),
          ...(typeof req.query.model === 'string' ? { model: req.query.model } : {}),
          ...(typeof req.query.language === 'string' ? { language: req.query.language } : {}),
        },
        pullRequestDependency(service),
      ]);
      res.json(result);
    } catch (error) {
      respondWithError(res, error, 'Failed to load walkthrough');
    }
  });

  // Generation outlives the request. A refresh detaches the client; only the
  // explicit cancel endpoint below stops the shared job.
  app.post('/api/walkthrough/generate', async (req, res) => {
    try {
      const service = await getWalkthroughService();
      const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
      const { directory, source, force, model, language, requestKey, retryOf } = body;
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory is required' });
      }
      const result = await invokeService(service, 'generateWalkthrough', [
        {
          directory,
          source,
          force: force === true,
          ...(typeof requestKey === 'string' ? { requestKey } : {}),
          ...(typeof retryOf === 'string' ? { retryOf } : {}),
          ...(typeof model === 'string' ? { model } : {}),
          ...(typeof language === 'string' ? { language } : {}),
        },
        pullRequestDependency(service),
      ]);
      if (clientIsGone(res)) return;
      res.json(result);
    } catch (error) {
      if (clientIsGone(res)) return;
      respondWithError(res, error, 'Failed to generate walkthrough');
    }
  });

  app.get('/api/walkthrough/progress', async (req, res) => {
    try {
      const service = await getWalkthroughService();
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
      const location = await invokeService<unknown>(service, 'getRepositoryRootFor', [directory, readSource(req.query.source)]);
      if (!location || typeof location !== 'object' || Array.isArray(location)) {
        throw new Error('Walkthrough service returned an invalid repository location');
      }
      const record = location as Record<string, unknown>;
      if (typeof record.repoRoot !== 'string' || typeof record.sourceKey !== 'string') {
        throw new Error('Walkthrough service returned an invalid repository location');
      }
      const stage = await invokeService(service, 'getGenerationStage', [record.repoRoot, record.sourceKey]);
      res.json({ stage });
    } catch (error) {
      respondWithError(res, error, 'Failed to read walkthrough progress');
    }
  });

  app.post('/api/walkthrough/cancel', async (req, res) => {
    try {
      const service = await getWalkthroughService();
      const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
      const { directory, source } = body;
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory is required' });
      }
      res.json(await invokeService(service, 'cancelWalkthroughGeneration', [{ directory, source }]));
    } catch (error) {
      respondWithError(res, error, 'Failed to cancel walkthrough generation');
    }
  });
}
