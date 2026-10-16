import type { Express, RequestHandler } from 'express';
import type { AgentPersonalization } from './agent-personalization.js';
import { AgentPersonalizationError, parseAgentScope } from './agent-personalization.js';
import { ResourceManagementFailure, type ResourceManagement } from '../agent-resources/management.js';

export function registerAgentPersonalizationRoutes(app: Express, service: AgentPersonalization, requireAuth: RequestHandler, preview: ResourceManagement['prompt']) {
  const error = (res: import('express').Response, failure: unknown) => res.status(failure instanceof AgentPersonalizationError || failure instanceof ResourceManagementFailure ? failure.status : 500)
    .json({ error: failure instanceof Error ? failure.message : 'Unable to update assistant preferences' });
  app.get('/api/agent-personalization', requireAuth, async (_req, res) => {
    try { res.json(await service.catalog()); } catch (failure) { error(res, failure); }
  });
  app.get('/api/agent-personalization/prompt', requireAuth, async (req, res) => {
    const abort = new AbortController();
    const closed = () => { if (!res.writableEnded) abort.abort(); };
    res.once('close', closed);
    try {
      const projectId = req.query.projectId;
      if (projectId !== undefined && (typeof projectId !== 'string' || !projectId.trim())) throw new AgentPersonalizationError('Choose a registered project');
      const result = await preview(projectId === undefined ? {} : { projectId }, abort.signal);
      if (!res.destroyed) res.json(result);
    } catch (failure) { if (!res.destroyed) error(res, failure); }
    finally { res.removeListener('close', closed); }
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
