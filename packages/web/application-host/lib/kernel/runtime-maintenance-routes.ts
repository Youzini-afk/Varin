import type { Express, RequestHandler } from 'express';
import type { AgentRuntimeClient } from './agent-runtime-client.js';

/** Host management only. Collection never selects a filesystem path or runs as a tool. */
export function registerRuntimeMaintenanceRoutes(
  app: Express,
  runtime: Pick<AgentRuntimeClient, 'collectContent'>,
  requireAuth: RequestHandler,
): void {
  app.post('/api/runtime/content/collect', requireAuth, async (request, response) => {
    const controller = new AbortController();
    const closed = () => {
      if (!response.writableEnded) controller.abort(new DOMException('Request closed', 'AbortError'));
    };
    response.once('close', closed);
    try {
      const body: unknown = request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) {
        response.status(400).json({ code: 'invalid-content-collection-request', error: 'An empty object is required' });
        return;
      }
      // The original worker report includes partial deletion counts on cancellation/failure.
      // Busy or interrupted collection is not translated into a successful zero-byte cleanup.
      response.json(await runtime.collectContent(controller.signal));
    } catch {
      response.status(500).json({ code: 'content-collection-request-failed', error: 'Content collection could not be completed' });
    } finally {
      response.removeListener('close', closed);
    }
  });
}
