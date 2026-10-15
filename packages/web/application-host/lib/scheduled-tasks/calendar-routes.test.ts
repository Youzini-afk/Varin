import type { Express, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { SourceResourceOwner } from '@varin/protocol';
import { createScheduledTaskService, type ScheduledTaskService } from './service.js';
import { createThreadSourceDirectory } from '../kernel/thread-sources.js';
import { SourceAdmissionError } from '../kernel/source-admission-error.js';
import { createScheduledTasksHttpAPI, switchRuntimeEndpoint } from '@varin/application-client';
import { registerScheduledTaskRoutes } from './routes.js';
import { KernelClientError } from '../kernel/kernel-error.js';

/** Real client/authenticated route chain; the asset-service port is explicit. */
function fixture(sourceService?: Pick<ScheduledTaskService, 'listSources' | 'resolveSource'>) {
  const occurrence = { id: 'occurrence', revision: 3, state: 'preparing', thread_id: 'thread', branch_id: 'branch', run_id: null };
  const service = { listSources: vi.fn(sourceService?.listSources ?? (async () => ({ targets: [], unavailable: [] }))),
    resolveSource: vi.fn(sourceService?.resolveSource ?? (async () => ({ resourceOwner: { kind: 'local' as const }, workspaceId: 'registered:local', path: '/local' }))),
    run: vi.fn(async () => ({ runtime: 'agent', occurrence, task: { id: 'task', name: 'Calendar', runtime: 'agent', enabled: true, target: { kind: 'existing_work', threadId: 'thread', branchId: 'branch' }, schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' }, execution: { prompt: 'Work' }, state: { createdAt: 0, updatedAt: 0 } } })),
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
    const response = Object.assign(new EventEmitter(), { status(code: number) { status = code; return this; }, json(value: unknown) { body = value; ended = true; return this; } }) as ExpressResponse;
    const request = { params, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) } as Request;
    await new Promise<void>((resolve, reject) => {
      const abort = () => { response.emit('close'); reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
      if (init.signal?.aborted) { abort(); return; }
      init.signal?.addEventListener('abort', abort, { once: true });
      let index = 0;
      const next = (error?: unknown) => {
        if (error) { reject(error); return; }
        const handler = route.chain[index++]; if (!handler) { resolve(); return; }
        Promise.resolve(handler(request, response, next)).then(() => { if (ended) { init.signal?.removeEventListener('abort', abort); resolve(); } }, reject);
      }; next();
    });
    return Response.json(body, { status });
  });
  return { api: createScheduledTasksHttpAPI(), service, occurrence, unauthenticate() { authenticated = false; } };
}
afterEach(() => vi.unstubAllGlobals());
it('the public client keeps manual keys and occurrence CAS, returns actual native occurrence identities and enforces route authentication', async () => {
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
  f.service.list.mockResolvedValueOnce([{ runtime: 'pi', id: 'old' }]);
  await expect(f.api.list('project')).rejects.toThrow('Invalid native scheduled task');
  let release!: (value: unknown[]) => void;
  f.service.list.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = f.api.list('project');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  switchRuntimeEndpoint({ apiBaseUrl: '', runtimeKey: 'calendar-other' }); release([]);
  await expect(pending).rejects.toThrow('Host changed');
});


it('calendar discovery and path resolution use the original directory inside authenticated project scope', async () => {
  const resourceOwner: SourceResourceOwner = { kind: 'managed_host', hostId: 'host-original', connectionId: 'connection-original', endpointIdentity: 'endpoint-original' };
  const localWorkspace = vi.fn(async () => ({ workspaceId: 'registered:local' }));
  const localRegistration = vi.fn(async () => ({ canonicalPath: '/canonical/local' }));
  const remote = {
    list: vi.fn(async () => ({ targets: [{ resourceOwner, label: 'Managed Host', capabilities: [] }], unavailable: [{ connectionId: 'offline', label: 'Offline Host', message: 'Unavailable' }] })),
    resolve: vi.fn(async () => ({ resourceOwner, workspaceId: 'registered:remote', path: '/canonical/remote' })),
  };
  const service = createScheduledTaskService({ readSettingsFromDisk: async () => ({ projects: [{ id: 'project / scope', path: '/project' }] }),
    sanitizeProjects: (value: unknown) => value as Array<{ id: string; path: string }>,
  } as unknown as Parameters<typeof createScheduledTaskService>[0]);
  service.bindSourceDirectory(createThreadSourceDirectory({ remote,
    documents: { resolveWorkspace: localWorkspace, admitWorkspaceRegistration: localRegistration } as unknown as Parameters<typeof createThreadSourceDirectory>[0]['documents'] }));
  const f = fixture(service);
  const sources = await f.api.listSources('project / scope');
  expect(sources.targets.map(target => target.resourceOwner)).toEqual([{ kind: 'local' }, resourceOwner]);
  expect(sources.unavailable).toEqual([{ connectionId: 'offline', label: 'Offline Host', message: 'Unavailable' }]);
  expect(await f.api.resolveSource('project / scope', { resourceOwner, path: '/requested/remote' })).toEqual({ resourceOwner, workspaceId: 'registered:remote', path: '/canonical/remote' });
  expect(remote.resolve).toHaveBeenCalledWith({ resourceOwner, path: '/requested/remote' }, expect.any(AbortSignal));
  expect(localWorkspace).not.toHaveBeenCalled();
  expect(await f.api.resolveSource('project / scope', { resourceOwner: { kind: 'local' }, path: '/requested/local' })).toEqual({ resourceOwner: { kind: 'local' }, workspaceId: 'registered:local', path: '/canonical/local' });
  expect(localWorkspace).toHaveBeenCalledWith({ path: '/requested/local' });
  expect(localRegistration).toHaveBeenCalledWith('registered:local', expect.any(AbortSignal));
  await expect(f.api.listSources('unknown-project')).rejects.toMatchObject({ status: 404 });
  await expect(f.api.resolveSource('unknown-project', { resourceOwner, path: '/remote' })).rejects.toMatchObject({ status: 404 });
  await expect(f.api.resolveSource('project / scope', { resourceOwner: { ...resourceOwner, token: 'rejected' } as SourceResourceOwner, path: '/remote' })).rejects.toMatchObject({ status: 400 });
  await expect(f.api.resolveSource('project / scope', { resourceOwner, path: ' ' })).rejects.toMatchObject({ status: 400 });
  expect(remote.list).toHaveBeenCalledTimes(1); expect(remote.resolve).toHaveBeenCalledTimes(1);
  f.unauthenticate();
  await expect(f.api.listSources('project / scope')).rejects.toMatchObject({ status: 401 });
  await expect(f.api.resolveSource('project / scope', { resourceOwner, path: '/remote' })).rejects.toMatchObject({ status: 401 });
  expect(remote.list).toHaveBeenCalledTimes(1); expect(remote.resolve).toHaveBeenCalledTimes(1);
});

it('source requests reject stale endpoint results and expose only typed source errors', async () => {
  const f = fixture();
  f.service.resolveSource.mockRejectedValueOnce(new SourceAdmissionError('source_changed'));
  await expect(f.api.resolveSource('project', { resourceOwner: { kind: 'local' }, path: '/source' })).rejects.toMatchObject({ status: 409 });
  f.service.resolveSource.mockRejectedValueOnce(new Error('Remote response containing secret'));
  await expect(f.api.resolveSource('project', { resourceOwner: { kind: 'local' }, path: '/source' })).rejects.toMatchObject({ status: 500, message: 'Scheduled task source request failed' });
  let release!: (value: { resourceOwner: { kind: 'local' }; workspaceId: string; path: string }) => void;
  f.service.resolveSource.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = f.api.resolveSource('project', { resourceOwner: { kind: 'local' }, path: '/source' });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  switchRuntimeEndpoint({ apiBaseUrl: '', runtimeKey: 'calendar-source-other' });
  release({ resourceOwner: { kind: 'local' }, workspaceId: 'old:registration', path: '/old' });
  await expect(pending).rejects.toThrow('Host changed');
});


it('cancelling source resolution propagates through the HTTP route to the shared owner', async () => {
  const f = fixture();
  let ownerSignal: AbortSignal | undefined;
  f.service.resolveSource.mockImplementationOnce((_project, _request, signal) => {
    ownerSignal = signal;
    return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
  });
  const controller = new AbortController();
  const pending = f.api.resolveSource('project', { resourceOwner: { kind: 'local' }, path: '/source' }, controller.signal);
  const failure = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(ownerSignal).toBeDefined());
  controller.abort();
  await failure;
  expect(ownerSignal?.aborted).toBe(true);
});
