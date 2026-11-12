import { assertRequestAccess } from './request-principal.js';
import type { Express, RequestHandler } from 'express';
import type { ThreadIdentity } from '@varin/application-client';
import { ThreadPreAdmissionError } from './thread-adapter.js';
import type { createThreadUserDispatch } from './thread-user-dispatch.js';
import { parseThreadDispatchInput } from './thread-user-dispatch.js';

/** Same authenticated Application Host ingress as ordinary Thread commands. */
export function registerThreadUserDispatchRoutes(app: Express, owner: ReturnType<typeof createThreadUserDispatch>, auth: RequestHandler): void {
  const post = (path: string, run: (body: unknown, signal: AbortSignal) => Promise<unknown>) => {
    app.post(`/api/threads/${path}`, auth, async (request, response) => {
      const controller = new AbortController();
      const closed = () => { if (!response.writableEnded) controller.abort(); };
      response.once('close', closed);
      try { const value = await run(request.body, controller.signal); if (!response.destroyed) response.json(value); }
      catch (error) {
        if (response.destroyed) return;
        const before = error instanceof ThreadPreAdmissionError;
        const cause = before ? error.reason : error;
        const code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : 'handoff-failed';
        response.status(code === 'forbidden' ? 403 : code.includes('conflict') ? 409 : 400).json({ code, error: 'The handoff could not be completed.', ...(before ? { admission: 'not_started' } : {}) });
      } finally { response.removeListener('close', closed); }
    });
  };
  post('child/dispatch/catalog', async (body, signal) => {
    const input = body as Partial<ThreadIdentity> | null;
    if (!input || Object.keys(input).some(key => !['runtime', 'threadId', 'branchId'].includes(key)) || input.runtime !== 'agent'
      || typeof input.threadId !== 'string' || !input.threadId || typeof input.branchId !== 'string' || !input.branchId) throw new Error('Select a native Thread and branch');
    await assertRequestAccess({ threads: [input.threadId] }, 'read');
    return owner.catalog(input as ThreadIdentity, signal);
  });
  post('child/dispatch', async (body, signal) => {
    const input = parseThreadDispatchInput(body);
    await assertRequestAccess({ threads: [input.threadId, ...(input.background?.map(reference => reference.threadId) ?? [])], runs: [input.runId] }, 'read');
    await assertRequestAccess({ threads: [input.threadId], runs: [input.runId] }, 'write');
    return owner.dispatch(input, signal);
  });
}
