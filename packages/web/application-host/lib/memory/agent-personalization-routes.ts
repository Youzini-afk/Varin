import type { Express, RequestHandler } from 'express';
import type { AgentPersonalization } from './agent-personalization.js';
import { AgentPersonalizationError, parseAgentScope } from './agent-personalization.js';

export function registerAgentPersonalizationRoutes(app: Express, service: AgentPersonalization, requireAuth: RequestHandler) {
  const error = (res: import('express').Response, failure: unknown) => res.status(failure instanceof AgentPersonalizationError ? failure.status : 500)
    .json({ error: failure instanceof Error ? failure.message : 'Unable to update assistant preferences' });
  app.get('/api/agent-personalization', requireAuth, async (_req, res) => {
    try { res.json(await service.catalog()); } catch (failure) { error(res, failure); }
  });
  app.put('/api/agent-personalization/memory', requireAuth, async (req, res) => {
    try {
      const body = req.body;
      if (!Number.isSafeInteger(body?.revision)) throw new AgentPersonalizationError('Memory revision is required');
      res.json(await service.saveNote({ id: body.id, content: body.content, scope: parseAgentScope(body.scope), revision: body.revision,
        source: { label: 'user' } }));
    } catch (failure) { error(res, failure); }
  });
  app.delete('/api/agent-personalization/memory/:id', requireAuth, async (req, res) => {
    try {
      if (!Number.isSafeInteger(req.body?.revision)) throw new AgentPersonalizationError('Memory revision is required');
      res.json(await service.removeNote(Number(req.params.id), req.body.revision));
    } catch (failure) { error(res, failure); }
  });
  app.put('/api/agent-personalization/prompt', requireAuth, async (req, res) => {
    try {
      if (!Number.isSafeInteger(req.body?.revision)) throw new AgentPersonalizationError('Prompt revision is required');
      res.json(await service.savePrompt(parseAgentScope(req.body.scope), req.body.profile, req.body.revision));
    } catch (failure) { error(res, failure); }
  });
}
