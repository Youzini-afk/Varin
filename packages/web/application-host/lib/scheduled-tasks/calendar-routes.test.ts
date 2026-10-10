import type { Express, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { createScheduledTasksHttpAPI, switchRuntimeEndpoint } from '@varin/application-client';
import { registerScheduledTaskRoutes } from './routes.js';
import { KernelClientError } from '../kernel/kernel-client.js';

/** Real client/authenticated route chain; the asset-service port is explicit. */
function fixture() {
  const occurrence = { id: 'occurrence', revision: 3, state: 'preparing', thread_id: 'thread', branch_id: 'branch', run_id: null };
  const service = { run: vi.fn(async () => ({ runtime: 'agent', occurrence, task: { id: 'task' } })),
    list: vi.fn(async (): Promise<unknown> => []), controlOccurrence: vi.fn(async () => ({ ...occurrence, revision: 4, state: 'cancelled' })), retryCalculation: vi.fn(async () => ({ revision: 7 })) };
  const routes: Array<{ method: string; pattern: string; chain: RequestHandler[] }> = [];
  const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [method, (pattern: string, ...chain: RequestHandler[]) => routes.push({ method, pattern, chain })])) as unknown as Express;
  let authenticated = true;
  const requireAuth: RequestHandler = (_req, res, next) => { if (authenticated) next(); else res.status(401).json({ error: 'Sign in required' }); };
  registerScheduledTaskRoutes(app, { scheduledTaskService: service, requireAuth } as unknown as Parameters<typeof registerScheduledTaskRoutes>[1]);
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const pathname = new URL(url, 'http://fixture.invalid').pathname;
    const route = routes.find(value => value.method === init.method?.toLowerCase() && new RegExp(`^${value.pattern.replace(/:[^/]+/g, '[^/]+')}$`).test(pathname));
    if (!route) throw new Error(`Missing route ${pathname}`);
    const params: Record<string, string> = {};
    route.pattern.split('/').forEach((part, index) => { if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(pathname.split('/')[index]!); });
    let status = 200, body: unknown, ended = false;
    const response = { status(code: number) { status = code; return this; }, json(value: unknown) { body = value; ended = true; return this; } } as ExpressResponse;
    const request = { params, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) } as Request;
    await new Promise<void>((resolve, reject) => {
      let index = 0;
      const next = (error?: unknown) => {
        if (error) { reject(error); return; }
        const handler = route.chain[index++]; if (!handler) { resolve(); return; }
        Promise.resolve(handler(request, response, next)).then(() => { if (ended) resolve(); }, reject);
      }; next();
    });
    return Response.json(body, { status });
  });
  return { api: createScheduledTasksHttpAPI(), service, occurrence, unauthenticate() { authenticated = false; } };
}
afterEach(() => vi.unstubAllGlobals());
it('the public client keeps manual keys and occurrence CAS, distinguishes acceptance from Pi sessions and enforces route authentication', async () => {
  const f = fixture();
  const accepted = await f.api.run('project', 'task', 'original-click');
  expect(accepted).toMatchObject({ runtime: 'agent', task: { id: 'task' }, occurrence: f.occurrence });
  expect(accepted).not.toHaveProperty('sessionId'); expect(f.service.run).toHaveBeenCalledWith('project', 'task', 'original-click');
  await f.api.controlOccurrence('project', 'task', 'occurrence', 3, 'cancel');
  expect(f.service.controlOccurrence).toHaveBeenCalledWith('project', 'task', 'occurrence', 3, 'cancel');
  f.service.controlOccurrence.mockRejectedValueOnce(new KernelClientError({ code: 'operation-error', message: 'operation error: conflict: original occurrence revision changed' }));
  await expect(f.api.controlOccurrence('project', 'task', 'occurrence', 3, 'cancel')).rejects.toMatchObject({ status: 409 });
  f.service.retryCalculation.mockRejectedValueOnce(new Error('Storage unavailable'));
  await expect(f.api.retryCalculation('project', 'task', 6)).rejects.toMatchObject({ status: 500 });
  f.unauthenticate(); await expect(f.api.run('project', 'task', 'original-click')).rejects.toMatchObject({ status: 401 });
  expect(f.service.run).toHaveBeenCalledTimes(1);
});
it('malformed lists and old endpoint responses do not become a successful empty/current calendar', async () => {
  const f = fixture(); f.service.list.mockResolvedValueOnce(null);
  await expect(f.api.list('project')).rejects.toThrow('Invalid scheduled task list');
  let release!: (value: unknown[]) => void;
  f.service.list.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = f.api.list('project');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  switchRuntimeEndpoint({ apiBaseUrl: '', runtimeKey: 'calendar-other' }); release([]);
  await expect(pending).rejects.toThrow('Host changed');
});
