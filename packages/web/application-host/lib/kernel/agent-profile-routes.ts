import type { Express, RequestHandler } from 'express';
import type { AgentProfilesAPI, AgentProfileSaveRequest } from '@varin/application-client';
import { agentProfileFailure } from './agent-profiles.js';

/** Profile editing does not select the runtime of any conversation. */
export function registerAgentProfileRoutes(app: Express, profiles: AgentProfilesAPI, requireAuth: RequestHandler): void {
  for (const action of ['read', 'save', 'remove'] as const) {
    app.post(`/api/agent-profiles/${action}`, requireAuth, async (request, response) => {
      const abort = new AbortController();
      const closed = () => { if (!response.writableEnded) abort.abort(); };
      response.once('close', closed);
      try {
        const input: unknown = request.body;
        const fields = action === 'read' ? ['runtime'] : action === 'save' ? ['runtime', 'expectedRevision', 'id', 'config', 'tools'] : ['runtime', 'expectedRevision', 'id'];
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) {
          response.status(400).json({ code: 'agent-profile-invalid', message: 'Invalid agent profile request.' });
          return;
        }
        const body = input as Record<string, unknown>;
        if (body.runtime !== 'agent'
          || (action !== 'read' && (typeof body.expectedRevision !== 'string' || !body.expectedRevision))
          || (action === 'remove' && typeof body.id !== 'string')) {
          response.status(400).json({ code: 'agent-profile-invalid', message: 'Reload native agent settings before editing.' });
          return;
        }
        const result = action === 'read' ? await profiles.read({ runtime: body.runtime }, abort.signal)
          : action === 'save' ? await profiles.save(body as unknown as AgentProfileSaveRequest, abort.signal)
            : await profiles.remove({ runtime: body.runtime, expectedRevision: body.expectedRevision as string, id: body.id as string }, abort.signal);
        response.json(result);
      } catch (error) {
        const failure = agentProfileFailure(error);
        response.status(failure.status).json({ code: failure.code, message: failure.message });
      } finally { response.removeListener('close', closed); }
    });
  }
}
