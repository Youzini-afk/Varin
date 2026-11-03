import type { Express, RequestHandler } from 'express';
import { KnowledgeMutationError } from '../knowledge/store.js';
import { AgentPersonalizationError } from './agent-personalization.js';
import type { createThreadRemember } from './thread-remember.js';
export function registerThreadRememberRoutes(app: Express, service: ReturnType<typeof createThreadRemember>, requireAuth: RequestHandler) {
  for (const action of ['scopes', 'remember'] as const) app.post(`/api/threads/memory/${action}`, requireAuth, async (req, res) => {
    try { res.json(await service[action](req.body)); }
    catch (error) {
      const status = error instanceof AgentPersonalizationError ? error.status : error instanceof KnowledgeMutationError ? error.code === 'conflict' ? 409 : error.code === 'not-found' ? 404 : 400 : 500;
      res.status(status).json({ error: error instanceof Error ? error.message : 'Memory save failed' });
    }
  });
}
